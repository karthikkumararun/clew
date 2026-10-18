// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let clew_lib::cli::CliAction::Print(text) =
        clew_lib::cli::parse(&args, env!("CARGO_PKG_VERSION"))
    {
        println!("{text}");
        return;
    }
    clew_lib::run()
}
