//! GitHub Copilot: the component download, the JSON-RPC client and the sign-in state machine.

pub mod install;
pub mod rpc;
pub mod service;

#[cfg(test)]
pub(crate) mod testing;
