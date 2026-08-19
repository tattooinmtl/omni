use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;
use tokio::time::sleep;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessRecord {
    pub id: String,
    pub payload: String,
    pub score: f64,
}

#[derive(Debug)]
pub enum EngineError {
    InvalidPayload(String),
    Timeout,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::InvalidPayload(msg) => write!(f, "Invalid Payload: {}", msg),
            EngineError::Timeout => write!(f, "Operation Timed Out"),
        }
    }
}

impl std::error::Error for EngineError {}

pub struct RustEngine {
    name: String,
}

impl RustEngine {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into() }
    }

    pub async fn process(&self, record: ProcessRecord) -> Result<ProcessRecord, EngineError> {
        if record.payload.is_empty() {
            return Err(EngineError::InvalidPayload("Payload cannot be empty".into()));
        }

        println!("[{}] Processing record: {}", self.name, record.id);
        sleep(Duration::from_millis(50)).await;

        let processed = ProcessRecord {
            id: record.id,
            payload: format!("PROCESSED_BY_{}", self.name),
            score: record.score * 1.2,
        };

        Ok(processed)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== Production Rust 2021 Tokio Starter ===");
    let engine = RustEngine::new("RustCoreEngine");

    let record = ProcessRecord {
        id: "rec_9931".into(),
        payload: "Tokio Async Event Stream".into(),
        score: 75.0,
    };

    let result = engine.process(record).await?;
    let json_output = serde_json::to_string_pretty(&result)?;

    println!("Verified Output:\n{}", json_output);
    Ok(())
}
