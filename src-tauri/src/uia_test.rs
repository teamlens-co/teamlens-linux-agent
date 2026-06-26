use uiautomation::*;
use uiautomation::variants::*;
use uiautomation::types::*;
use uiautomation::patterns::ValuePattern;

pub fn test_val(auto: &UIAutomation, root: UIElement) {
    if let Ok(cond) = auto.create_property_condition(UIProperty::ControlType, Variant::from(ControlType::Edit as i32), None) {
        if let Ok(edit) = root.find_first(TreeScope::Descendants, &cond) {
            if let Ok(pattern) = edit.get_pattern::<ValuePattern>() {
                if let Ok(val) = pattern.get_value() {
                    let _: String = val;
                }
            }
        }
    }
}
