//! `mica` binary entrypoint — parse args, run, map errors to exit codes.

use std::process::ExitCode;

fn main() -> ExitCode {
    match mica_cli::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("mica: {e}");
            ExitCode::from(e.exit_code())
        }
    }
}
