use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, Weak},
};
use tokio::sync::{
    Mutex, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedSemaphorePermit, RwLock, RwLockWriteGuard,
    Semaphore,
};

pub(crate) struct QueryGate {
    accounts: StdMutex<HashMap<String, Weak<Mutex<()>>>>,
    refresh_barrier: Arc<RwLock<()>>,
    queries: Arc<Semaphore>,
}

impl Default for QueryGate {
    fn default() -> Self {
        Self {
            accounts: StdMutex::new(HashMap::new()),
            refresh_barrier: Arc::new(RwLock::new(())),
            queries: Arc::new(Semaphore::new(2)),
        }
    }
}

// 随查询结果持有到凭据落盘，不能在网络返回时提前释放。
pub(crate) struct QueryPermit {
    _account: OwnedMutexGuard<()>,
    _barrier: OwnedRwLockReadGuard<()>,
    _slot: OwnedSemaphorePermit,
}

impl QueryGate {
    pub async fn acquire(&self, account_id: &str) -> QueryPermit {
        let account = {
            let mut accounts = self
                .accounts
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            accounts.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = accounts.get(account_id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(Mutex::new(()));
                accounts.insert(account_id.to_string(), Arc::downgrade(&lock));
                lock
            }
        };
        // 同账号等待者不占用全局并发名额。
        let account = account.lock_owned().await;
        let barrier = self.refresh_barrier.clone().read_owned().await;
        let slot = self
            .queries
            .clone()
            .acquire_owned()
            .await
            .expect("query semaphore is never closed");
        QueryPermit {
            _account: account,
            _barrier: barrier,
            _slot: slot,
        }
    }

    // 导入可能在解析后才知道账号；迁移操作仍与所有凭据轮换互斥。
    pub async fn exclusive(&self) -> RwLockWriteGuard<'_, ()> {
        self.refresh_barrier.write().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{pin_mut, poll};

    #[test]
    fn separate_accounts_progress_but_duplicates_and_excess_queries_wait() {
        tauri::async_runtime::block_on(async {
            let gate = QueryGate::default();
            let first = gate.acquire("a").await;
            let duplicate = gate.acquire("a");
            pin_mut!(duplicate);
            assert!(poll!(&mut duplicate).is_pending());
            let second = gate.acquire("b");
            pin_mut!(second);
            let second = match poll!(&mut second) {
                std::task::Poll::Ready(value) => value,
                _ => panic!("B must not wait for A"),
            };
            let third = gate.acquire("c");
            pin_mut!(third);
            assert!(poll!(&mut third).is_pending());
            drop(second);
            let third = third.await;
            drop(first);
            let duplicate = duplicate.await;
            drop((third, duplicate));
            let _next = gate.acquire("d").await;
            assert_eq!(gate.accounts.lock().unwrap().len(), 1);
        });
    }

    #[test]
    fn transfers_wait_for_persistence_and_block_new_refreshes() {
        tauri::async_runtime::block_on(async {
            let gate = QueryGate::default();
            let query = gate.acquire("a").await;
            let transfer = gate.exclusive();
            pin_mut!(transfer);
            assert!(poll!(&mut transfer).is_pending());
            drop(query);
            let transfer = transfer.await;
            let query = gate.acquire("b");
            pin_mut!(query);
            assert!(poll!(&mut query).is_pending());
            drop(transfer);
            query.await;
        });
    }
}
