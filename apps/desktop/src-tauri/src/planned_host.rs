//! Adapt a trusted planned step to the existing native action/receipt boundary.
use serde_json::Value;
pub fn action_view(task: &Value) -> Result<Value, String> {
    let step = &task["current_step"];
    if step["definition"]["op"] != "write" {
        return Err("Current step is not a file write".into());
    }
    let id = step["definition"]["output"]
        .as_str()
        .and_then(|s| s.strip_prefix("output"))
        .and_then(|s| s.parse::<usize>().ok())
        .and_then(|i| i.checked_sub(1))
        .ok_or("Invalid output reference")?;
    let mut view = task.clone();
    view["output_path"] = task["outputs"][id]["path"].clone();
    if !view["output_path"].is_string() {
        return Err("Output is outside selected resources".into());
    }
    view["runs"][0]["action"] = step["action"].clone();
    Ok(view)
}
pub fn artifact_view(task: &Value, output: &Value) -> Result<Value, String> {
    let id = output
        .as_str()
        .unwrap_or("output1")
        .strip_prefix("output")
        .and_then(|s| s.parse::<usize>().ok())
        .and_then(|i| i.checked_sub(1))
        .ok_or("Invalid output reference")?;
    let mut view = task.clone();
    view["output_path"] = task["outputs"][id]["path"].clone();
    if !view["output_path"].is_string() {
        return Err("Output is outside selected resources".into());
    }
    Ok(view)
}
