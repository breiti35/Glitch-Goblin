use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

#[derive(Clone, Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub terminal_id: String,
    pub data: String,
}

pub enum TerminalCmd {
    Write(String),
    Resize(u32, u32), // cols, rows — matches xterm.js { cols, rows } destructuring
    Close,
}

pub struct TerminalSession {
    pub cmd_tx: std::sync::mpsc::Sender<TerminalCmd>,
}

pub fn detect_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();

    #[cfg(windows)]
    {
        if which_exists("pwsh.exe") {
            shells.push(ShellInfo {
                name: "PowerShell 7".into(),
                path: "pwsh.exe".into(),
            });
        }
        shells.push(ShellInfo {
            name: "PowerShell".into(),
            path: "powershell.exe".into(),
        });
        shells.push(ShellInfo {
            name: "CMD".into(),
            path: "cmd.exe".into(),
        });
        for path in &[
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            if std::path::Path::new(path).exists() {
                shells.push(ShellInfo {
                    name: "Git Bash".into(),
                    path: path.to_string(),
                });
                break;
            }
        }
    }

    #[cfg(not(windows))]
    {
        for (name, path) in &[
            ("Bash", "/bin/bash"),
            ("Zsh", "/bin/zsh"),
            ("Fish", "/usr/bin/fish"),
        ] {
            if std::path::Path::new(path).exists() {
                shells.push(ShellInfo {
                    name: name.to_string(),
                    path: path.to_string(),
                });
            }
        }
    }

    shells
}

#[cfg(windows)]
fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("where")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub async fn spawn_terminal(
    shell: &str,
    cwd: &str,
    terminal_id: String,
    app_handle: tauri::AppHandle,
) -> Result<TerminalSession, String> {
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<TerminalCmd>();
    let (setup_tx, setup_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    let shell = shell.to_string();
    let cwd = cwd.to_string();
    let id = terminal_id.clone();

    std::thread::spawn(move || {
        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(p) => p,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("Failed to open PTY: {e}")));
                return;
            }
        };

        let mut cmd_builder = CommandBuilder::new(&shell);
        cmd_builder.cwd(&cwd);

        let mut child = match pair.slave.spawn_command(cmd_builder) {
            Ok(c) => c,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("Failed to spawn shell: {e}")));
                return;
            }
        };
        drop(pair.slave);

        let mut writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("Failed to get PTY writer: {e}")));
                return;
            }
        };

        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("Failed to get PTY reader: {e}")));
                return;
            }
        };

        // Reader thread — streams PTY output to frontend
        let closed = Arc::new(AtomicBool::new(false));
        let closed2 = closed.clone();
        let app2 = app_handle.clone();
        let id2 = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut reader = reader;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app2.emit(
                            "terminal-output",
                            TerminalOutput {
                                terminal_id: id2.clone(),
                                data,
                            },
                        );
                    }
                    Err(e) => {
                        // Log the error so unexpected failures are diagnosable.
                        // EIO / EPIPE on process exit are normal on some platforms;
                        // any other error indicates a real PTY problem.
                        eprintln!("[terminal {id2}] PTY read error: {e}");
                        break;
                    }
                }
            }
            closed2.store(true, Ordering::Relaxed);
            let _ = app2.emit(
                "terminal-closed",
                serde_json::json!({ "terminalId": id2 }),
            );
        });

        // Signal successful setup
        let _ = setup_tx.send(Ok(()));

        // Command loop — master stays in this thread for resize
        let master = pair.master;
        loop {
            match cmd_rx.recv_timeout(Duration::from_secs(1)) {
                Ok(TerminalCmd::Write(data)) => {
                    let _ = writer.write_all(data.as_bytes());
                    let _ = writer.flush();
                }
                Ok(TerminalCmd::Resize(cols, rows)) => {
                    let _ = master.resize(PtySize {
                        rows: rows as u16,
                        cols: cols as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Ok(TerminalCmd::Close) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if closed.load(Ordering::Relaxed) {
                        let _ = child.wait();
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    });

    setup_rx
        .await
        .map_err(|_| "Terminal thread died during setup".to_string())??;

    Ok(TerminalSession { cmd_tx })
}
