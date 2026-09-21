// JXA / AppKit。参数通过 argv 传递，不拼接为脚本；绝不读取进程参数或认证数据。
ObjC.import("AppKit");
function run(argv) {
  const bundleId = "com.openai.codex";
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId).js;
  function info(app) {
    return {
      pid: Number(app.processIdentifier),
      path: app.bundleURL.path.js,
      executable: app.executableURL.path.js,
      started: String(app.launchDate.timeIntervalSince1970),
    };
  }
  if (argv[0] === "detect") return JSON.stringify(apps.map(info));
  const bundle = $.NSBundle.bundleWithPath(argv[2]);
  if (!bundle || bundle.bundleIdentifier.js !== bundleId || bundle.executableURL.path.js !== argv[3]) {
    throw new Error("invalid application");
  }
  if (argv[0] === "validate") return "true";
  if (argv[0] !== "close") throw new Error("invalid action");
  for (const app of apps) {
    const current = info(app);
    if (current.pid !== Number(argv[1]) || current.path !== argv[2] ||
        current.executable !== argv[3] || current.started !== argv[4]) {
      throw new Error("application changed");
    }
    if (!app.terminate) throw new Error("quit request failed");
  }
  return "true";
}
