//! BetaCode desktop shell.
//!
//! Hosts the web UI and a native folder picker, and starts the bundled Node runtime (`runtime/server.mjs`,
//! which owns the agent, tools, permissions and database) as a child process. The UI reaches it over
//! loopback HTTP on port 4317. If something is already listening on that port (for example `pnpm dev`),
//! it is reused instead of starting a second runtime.

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};

const PORT: u16 = 4317;

struct Runtime(Mutex<Option<Child>>);

fn runtime_is_up() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn start_runtime(app: &tauri::AppHandle) -> Result<Option<Child>, String> {
    if runtime_is_up() {
        return Ok(None);
    }
    // The Node binary is bundled next to the app executable (Tauri strips the target triple).
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("no executable directory")?;
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("runtime")
        .join("server.mjs");
    // Windows resource paths come back as \\?\D:\... (verbatim form), which Node cannot open.
    let script = std::path::PathBuf::from(script.to_string_lossy().trim_start_matches(r"\\?\"));
    if !node.exists() || !script.exists() {
        return Err(format!(
            "bundled runtime not found (node: {}, script: {})",
            node.display(),
            script.display()
        ));
    }
    // Runtime output goes to ~/.betacode/logs/runtime-stdio.log so startup failures are diagnosable.
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let (out, err) = match home {
        Some(h) => {
            let dir = std::path::PathBuf::from(h).join(".betacode").join("logs");
            let _ = std::fs::create_dir_all(&dir);
            match std::fs::OpenOptions::new().create(true).append(true).open(dir.join("runtime-stdio.log")) {
                Ok(f) => (
                    Stdio::from(f.try_clone().map_err(|e| e.to_string())?),
                    Stdio::from(f),
                ),
                Err(_) => (Stdio::null(), Stdio::null()),
            }
        }
        None => (Stdio::null(), Stdio::null()),
    };
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .env("BETACODE_PORT", PORT.to_string())
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map(Some).map_err(|e| e.to_string())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            match start_runtime(app.handle()) {
                Ok(child) => {
                    app.manage(Runtime(Mutex::new(child)));
                }
                Err(e) => {
                    eprintln!("BetaCode: could not start the runtime: {e}");
                    app.manage(Runtime(Mutex::new(None)));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building BetaCode");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(rt) = handle.try_state::<Runtime>() {
                if let Some(mut child) = rt.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
