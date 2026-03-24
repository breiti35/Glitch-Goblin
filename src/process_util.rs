/// Erstellt ein `std::process::Command` mit `CREATE_NO_WINDOW` Flag auf Windows,
/// damit keine Konsolenfenster aufpoppen wenn die App ohne eigene Konsole laeuft.
pub fn cmd_no_window(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Erstellt ein `tokio::process::Command` mit `CREATE_NO_WINDOW` Flag auf Windows,
/// damit keine Konsolenfenster aufpoppen wenn die App ohne eigene Konsole laeuft.
pub fn async_cmd_no_window(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
