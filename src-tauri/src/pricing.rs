//! 公开价格文档的兼容层。只下载固定 URL，不携带账号凭据或本地用量。
//! Markdown 结构不是稳定 API；解析失败保留上次价格，不猜测价格或模型别名。
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path, time::Duration};

const DOCUMENT_URL: &str = "https://developers.openai.com/api/docs/pricing.md";
pub const SOURCE_URL: &str = "https://developers.openai.com/api/docs/pricing";
const CACHE_FILE: &str = "model-prices.v1.json";
const MAX_BYTES: usize = 2 * 1024 * 1024;
static PRICE_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    model: String,
    input: f64,
    cached_input: Option<f64>,
    cache_write: Option<f64>,
    output: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceSnapshot {
    updated_at: u64,
    prices: Vec<ModelPrice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrices {
    #[serde(flatten)]
    snapshot: PriceSnapshot,
    source_url: &'static str,
    source: &'static str,
    warning: Option<&'static str>,
}

fn valid_rate(rate: f64) -> bool {
    rate.is_finite() && (0.0..1_000_000.0).contains(&rate)
}

fn valid_price(price: &ModelPrice) -> bool {
    !price.model.is_empty()
        && price.model.len() <= 128
        && price
            .model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && valid_rate(price.input)
        && price.input > 0.0
        && valid_rate(price.output)
        && price.output > 0.0
        && price
            .cached_input
            .is_none_or(|rate| valid_rate(rate) && rate <= price.input)
        && price.cache_write.is_none_or(valid_rate)
}

fn decode_snapshot(bytes: &[u8]) -> Option<PriceSnapshot> {
    let snapshot: PriceSnapshot = serde_json::from_slice(bytes).ok()?;
    let now = chrono::Utc::now().timestamp().max(0) as u64;
    let mut models = std::collections::HashSet::new();
    (snapshot.updated_at > 0
        && snapshot.updated_at <= now.saturating_add(300)
        && !snapshot.prices.is_empty()
        && snapshot.prices.len() <= 1000
        && snapshot
            .prices
            .iter()
            .all(|price| valid_price(price) && models.insert(&price.model)))
    .then_some(snapshot)
}

fn read_snapshot(path: &Path) -> Option<PriceSnapshot> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_BYTES)
        .then(|| decode_snapshot(&bytes))
        .flatten()
}

fn dollars(cell: &str) -> Result<Option<f64>, ()> {
    if cell == "-" {
        return Ok(None);
    }
    let rate = cell
        .strip_prefix('$')
        .ok_or(())?
        .parse::<f64>()
        .map_err(|_| ())?;
    valid_rate(rate).then_some(Some(rate)).ok_or(())
}

// 仅读取 Standard 文本表及 Standard 的 Codex 分类；排除 Batch/Flex/Fast 和多模态表。
fn parse_prices(markdown: &str) -> Result<Vec<ModelPrice>, ()> {
    let mut prices = BTreeMap::new();
    let mut standard = false;
    let mut primary_heading = false;
    let mut table = 0;
    let mut primary_count = 0;
    for line in markdown.lines().map(str::trim) {
        match line {
            "Standard" => {
                standard = true;
                table = 0;
            }
            "Batch" | "Flex" | "Fast" | "Fast mode" | "Priority" => {
                standard = false;
                table = 0;
            }
            _ => {}
        }
        if line.starts_with("### ") {
            primary_heading = line == "### Standard pricing data";
            table = 0;
        }
        if !line.starts_with('|') {
            if !line.is_empty() {
                table = 0;
            }
            continue;
        }
        let cells: Vec<_> = line.trim_matches('|').split('|').map(str::trim).collect();
        if cells
            == [
                "Model",
                "Short context input",
                "Short context cached input",
                "Short context cache writes",
                "Short context output",
                "Long context input",
                "Long context cached input",
                "Long context cache writes",
                "Long context output",
            ]
        {
            table = if standard && primary_heading { 1 } else { 0 };
            continue;
        }
        if cells == ["Category", "Model", "Input", "Cached input", "Output"] {
            table = if standard { 2 } else { 0 };
            continue;
        }
        if cells.first().is_some_and(|cell| cell.starts_with("---")) {
            continue;
        }
        let price = match table {
            1 if cells.len() == 9 => {
                primary_count += 1;
                ModelPrice {
                    model: cells[0].split(" (").next().ok_or(())?.to_string(),
                    input: dollars(cells[1])?.ok_or(())?,
                    cached_input: dollars(cells[2])?,
                    cache_write: dollars(cells[3])?,
                    output: dollars(cells[4])?.ok_or(())?,
                }
            }
            2 if cells.len() == 5 && cells[0] == "Codex" => ModelPrice {
                model: cells[1].to_string(),
                input: dollars(cells[2])?.ok_or(())?,
                cached_input: dollars(cells[3])?,
                cache_write: None,
                output: dollars(cells[4])?.ok_or(())?,
            },
            1 => return Err(()),
            _ => continue,
        };
        if !valid_price(&price) || prices.insert(price.model.clone(), price).is_some() {
            return Err(());
        }
    }
    if primary_count < 5 || prices.len() > 1000 {
        return Err(());
    }
    Ok(prices.into_values().collect())
}

async fn fetch_snapshot() -> Result<PriceSnapshot, ()> {
    let client =
        crate::proxy::cached_client("codex-auth-switch-pricing", Duration::from_secs(20), || {
            "无法初始化价格查询".to_string()
        })
        .map_err(|_| ())?;
    let mut response = client
        .get(DOCUMENT_URL)
        .send()
        .await
        .map_err(|_| ())?
        .error_for_status()
        .map_err(|_| ())?;
    if response.url().scheme() != "https"
        || response.url().host_str() != Some("developers.openai.com")
        || response
            .content_length()
            .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    let prices = parse_prices(std::str::from_utf8(&bytes).map_err(|_| ())?)?;
    Ok(PriceSnapshot {
        updated_at: chrono::Utc::now().timestamp().max(0) as u64,
        prices,
    })
}

pub async fn get_prices(app_data: &Path, refresh: bool) -> Result<ModelPrices, String> {
    let _guard = PRICE_GATE.lock().await;
    let path = app_data.join(CACHE_FILE);
    let cached = read_snapshot(&path);
    let source = if cached.is_some() { "cache" } else { "bundled" };
    let snapshot = cached
        .or_else(|| decode_snapshot(include_bytes!("../../src/pricing-snapshot.json")))
        .ok_or_else(|| "无法读取模型价格".to_string())?;
    let mut result = ModelPrices {
        snapshot,
        source_url: SOURCE_URL,
        source,
        warning: None,
    };
    if refresh {
        match fetch_snapshot().await {
            Ok(snapshot) => {
                let bytes =
                    serde_json::to_vec(&snapshot).map_err(|_| "无法保存模型价格".to_string())?;
                if crate::manager::atomic_write(&path, &bytes).is_err() {
                    result.warning = Some("cacheWriteFailed");
                }
                result.snapshot = snapshot;
                result.source = "live";
            }
            Err(()) => result.warning = Some("fetchFailed"),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 独立运行：cargo test pricing::tests::refreshes_public_prices -- --ignored
    #[test]
    #[ignore = "requires access to the public OpenAI pricing document"]
    fn refreshes_public_prices() {
        let root = tempfile::tempdir().unwrap();
        crate::proxy::init(root.path().to_path_buf());
        tauri::async_runtime::block_on(async {
            let fetched = get_prices(root.path(), true).await.unwrap();
            assert_eq!(fetched.source, "live");
            assert!(fetched.warning.is_none());
            assert!(fetched
                .snapshot
                .prices
                .iter()
                .any(|price| price.model == "gpt-5.3-codex"));
            let cached = get_prices(root.path(), false).await.unwrap();
            assert_eq!(cached.source, "cache");
            assert_eq!(cached.snapshot.updated_at, fetched.snapshot.updated_at);
            assert_eq!(cached.snapshot.prices.len(), fetched.snapshot.prices.len());
        });
    }

    #[test]
    fn parses_standard_prices_without_overwriting_with_fast_or_multimodal() {
        let markdown = include_str!("../tests/fixtures/pricing.md");
        let prices = parse_prices(markdown).unwrap();
        let astra = prices.iter().find(|p| p.model == "gpt-6-astra").unwrap();
        assert_eq!(
            (
                astra.input,
                astra.cached_input,
                astra.cache_write,
                astra.output
            ),
            (10.0, Some(1.0), Some(12.5), 50.0)
        );
        assert_eq!(
            prices
                .iter()
                .find(|p| p.model == "gpt-5.3-codex")
                .unwrap()
                .input,
            1.75
        );
        assert!(prices.iter().any(|p| p.model == "gpt-5.5"));
        assert!(!prices.iter().any(|p| p.model == "image-model"));
        assert!(parse_prices(&markdown.replace("$10.00", "$NaN")).is_err());
        assert!(parse_prices(&markdown.replace("Short context input", "New column")).is_err());
        assert!(parse_prices("<html>service unavailable</html>").is_err());
    }

    #[test]
    fn validates_bundled_and_cached_prices() {
        let bytes = include_bytes!("../../src/pricing-snapshot.json");
        assert!(decode_snapshot(bytes).unwrap().prices.len() > 5);
        assert!(decode_snapshot(b"{}").is_none());
        let mut snapshot: PriceSnapshot = serde_json::from_slice(bytes).unwrap();
        snapshot.prices[0].input = -1.0;
        assert!(decode_snapshot(&serde_json::to_vec(&snapshot).unwrap()).is_none());
    }

    #[test]
    fn offline_load_uses_valid_cache_and_recovers_from_corruption() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let bundled = get_prices(root.path(), false).await.unwrap();
            assert_eq!(bundled.source, "bundled");
            let path = root.path().join(CACHE_FILE);
            std::fs::write(&path, serde_json::to_vec(&bundled.snapshot).unwrap()).unwrap();
            assert_eq!(
                get_prices(root.path(), false).await.unwrap().source,
                "cache"
            );
            std::fs::write(&path, "broken cache").unwrap();
            assert_eq!(
                get_prices(root.path(), false).await.unwrap().source,
                "bundled"
            );
        });
    }
}
