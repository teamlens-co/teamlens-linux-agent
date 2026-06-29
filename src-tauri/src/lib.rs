use device_query::{DeviceQuery, DeviceState, Keycode};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use image::{ImageBuffer, ImageEncoder};
use scrap::Capturer;
use std::io::{Cursor, ErrorKind};
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use std::path::Path;
use std::ptr::null_mut;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};

#[cfg(target_os = "linux")]
use std::process::Command;
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, HWND};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
};

#[cfg(target_os = "windows")]
#[repr(C)]
struct LastInputInfo {
    cbSize: u32,
    dwTime: u32,
}

#[cfg(target_os = "windows")]
extern "system" {
    fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    fn GetTickCount() -> u32;
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

const KEYRING_SERVICE: &str = "teamlens.desktop.agent";
const KEYRING_ACCOUNT: &str = "auth_token";

#[derive(Default)]
struct InputCounter {
    mouse_moves: u64,
    key_presses: u64,
}

#[derive(Serialize)]
struct InputCounts {
    mouse_moves: u64,
    key_presses: u64,
}

static INPUT_TRACKER_RUNNING: OnceLock<Arc<std::sync::atomic::AtomicBool>> = OnceLock::new();
static INPUT_TRACKER_STARTED: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();

#[derive(Serialize)]
struct ActiveWindowInfo {
    app_name: String,
    window_title: String,
    process_path: String,
    browser_url: Option<String>,
}

static INPUT_COUNTER: OnceLock<Arc<Mutex<InputCounter>>> = OnceLock::new();
static SCREEN_CAPTURE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

thread_local! {
    static SCREEN_CAPTURER: RefCell<Option<ScreenCapturerState>> = RefCell::new(None);
}

struct ScreenCapturerState {
    capturer: Capturer,
    width: usize,
    height: usize,
}

fn create_screen_capturer_state() -> Result<ScreenCapturerState, String> {
    let display = scrap::Display::all()
        .map_err(|e| format!("Failed to get displays: {}", e))?
        .into_iter()
        .next()
        .ok_or("No displays found".to_string())?;

    let width = display.width();
    let height = display.height();
    let capturer = Capturer::new(display).map_err(|e| format!("Failed to create capturer: {}", e))?;

    Ok(ScreenCapturerState {
        capturer,
        width,
        height,
    })
}

#[cfg(target_os = "linux")]
fn capture_screen_frame_x11() -> Result<(Vec<u8>, usize, usize), String> {
    use x11::xlib;
    unsafe {
        let display = xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return Err("X11: XOpenDisplay failed. Is DISPLAY set?".to_string());
        }
        let screen = xlib::XDefaultScreen(display);
        let root = xlib::XDefaultRootWindow(display);
        let width = xlib::XDisplayWidth(display, screen) as usize;
        let height = xlib::XDisplayHeight(display, screen) as usize;

        let image = xlib::XGetImage(
            display,
            root,
            0,
            0,
            width as u32,
            height as u32,
            xlib::XAllPlanes(),
            xlib::ZPixmap,
        );
        if image.is_null() {
            xlib::XCloseDisplay(display);
            return Err("X11: XGetImage failed".to_string());
        }

        let img = &*image;
        let bpl = img.bytes_per_line as usize;
        let bits_per_pixel = img.bits_per_pixel as usize;
        let data = img.data as *const u8;
        let red_mask = img.red_mask as u64;
        let green_mask = img.green_mask as u64;
        let blue_mask = img.blue_mask as u64;
        let red_shift = red_mask.trailing_zeros();
        let green_shift = green_mask.trailing_zeros();
        let blue_shift = blue_mask.trailing_zeros();

        let mut out = Vec::with_capacity(width * height * 4);

        for y in 0..height {
            for x in 0..width {
                let (r, g, b) = if bits_per_pixel == 32 {
                    let pixel =
                        std::ptr::read_unaligned(data.add(y * bpl + x * 4) as *const u32) as u64;
                    (
                        ((pixel & red_mask) >> red_shift) as u8,
                        ((pixel & green_mask) >> green_shift) as u8,
                        ((pixel & blue_mask) >> blue_shift) as u8,
                    )
                } else if bits_per_pixel == 24 {
                    let p = data.add(y * bpl + x * 3);
                    // 24-bit still packs R/G/B, but order depends on server. We
                    // decompose with masks at byte level for safety.
                    let pixel = ((*p.add(0) as u64))
                        | ((*p.add(1) as u64) << 8)
                        | ((*p.add(2) as u64) << 16);
                    (
                        ((pixel & red_mask) >> red_shift) as u8,
                        ((pixel & green_mask) >> green_shift) as u8,
                        ((pixel & blue_mask) >> blue_shift) as u8,
                    )
                } else {
                    xlib::XDestroyImage(image);
                    xlib::XCloseDisplay(display);
                    return Err(format!("X11: unsupported bits_per_pixel {}", bits_per_pixel));
                };

                out.push(b);
                out.push(g);
                out.push(r);
                out.push(255);
            }
        }

        xlib::XDestroyImage(image);
        xlib::XCloseDisplay(display);
        Ok((out, width, height))
    }
}

fn capture_screen_frame() -> Result<(Vec<u8>, usize, usize), String> {
    #[cfg(target_os = "linux")]
    match capture_screen_frame_x11() {
        Ok(frame) => return Ok(frame),
        Err(err) => eprintln!("[ScreenCapture] X11 capture failed, falling back to scrap: {}", err),
    }

    let _capture_guard = SCREEN_CAPTURE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|err| format!("Failed to lock screen capture: {}", err))?;

    let mut frame_data: Option<(Vec<u8>, usize, usize)> = None;

    for _ in 0..40 {
        let captured = SCREEN_CAPTURER.with(|capturer_cell| -> Result<Option<(Vec<u8>, usize, usize)>, String> {
            let mut state = capturer_cell.borrow_mut();

            if state.is_none() {
                *state = Some(create_screen_capturer_state()?);
            }

            let active = state
                .as_mut()
                .ok_or_else(|| "Screen capturer state missing".to_string())?;

            match active.capturer.frame() {
                Ok(frame) => Ok(Some((frame.to_vec(), active.width, active.height))),
                Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(None),
                Err(error) => {
                    eprintln!("[ScreenCapture] Capturer became invalid, recreating: {}", error);
                    *state = None;
                    Ok(None)
                }
            }
        })?;

        if let Some(captured_frame) = captured {
            frame_data = Some(captured_frame);
            break;
        }

        thread::sleep(Duration::from_millis(8));
    }

    frame_data.ok_or_else(|| {
        "Failed to capture frame: timeout waiting for first available frame".to_string()
    })
}

fn capture_frame_png(compression: CompressionType, filter: PngFilterType) -> Result<Vec<u8>, String> {
    let (frame, width, height) = capture_screen_frame()?;

    let stride = frame.len() / height;
    let mut image_data = Vec::with_capacity(width * height * 4);

    for y in 0..height {
        let row_start = y * stride;
        for x in 0..width {
            let offset = row_start + x * 4;
            if offset + 2 >= frame.len() {
                return Err("Captured frame ended unexpectedly".to_string());
            }

            image_data.push(frame[offset + 2]);
            image_data.push(frame[offset + 1]);
            image_data.push(frame[offset]);
            image_data.push(255);
        }
    }

    let width_u32 = width as u32;
    let height_u32 = height as u32;
    let image = ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(width_u32, height_u32, image_data)
        .ok_or("Failed to create image buffer")?;

    let mut png_data = Vec::new();
    {
        let cursor = Cursor::new(&mut png_data);
        PngEncoder::new_with_quality(cursor, compression, filter)
            .write_image(&image, width_u32, height_u32, image::ColorType::Rgba8)
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;
    }

    Ok(png_data)
}

/// Try to get mouse position via xdotool (X11 shell command).
/// Works on X11 without any special permissions.
#[cfg(target_os = "linux")]
fn get_mouse_pos_shell_xdotool() -> Option<(i32, i32)> {
    let out = Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let stdout = std::str::from_utf8(&out.stdout).ok()?;
    let mut x = 0i32;
    let mut y = 0i32;
    for line in stdout.lines() {
        if let Some(val) = line.strip_prefix("X=").and_then(|v| v.trim().parse().ok()) {
            x = val;
        }
        if let Some(val) = line.strip_prefix("Y=").and_then(|v| v.trim().parse().ok()) {
            y = val;
        }
    }
    Some((x, y))
}

/// Try to get mouse position via the X11 crate (libX11).
/// This is the most reliable method on X11 systems.
#[cfg(target_os = "linux")]
fn get_mouse_pos_x11_lib() -> Option<(i32, i32)> {
    use x11::xlib;
    unsafe {
        let display = xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() { return None; }
        let mut root: xlib::Window = std::mem::zeroed();
        let mut child: xlib::Window = std::mem::zeroed();
        let mut root_x: i32 = 0;
        let mut root_y: i32 = 0;
        let mut win_x: i32 = 0;
        let mut win_y: i32 = 0;
        let mut mask: u32 = 0;
        let ret = xlib::XQueryPointer(
            display, xlib::XDefaultRootWindow(display),
            &mut root, &mut child,
            &mut root_x, &mut root_y,
            &mut win_x, &mut win_y,
            &mut mask,
        );
        xlib::XCloseDisplay(display);
        if ret != 0 {
            Some((root_x, root_y))
        } else {
            None
        }
    }
}

fn start_global_input_tracker() {
    let already_started = INPUT_TRACKER_STARTED
        .get_or_init(|| std::sync::atomic::AtomicBool::new(false));
    if already_started.swap(true, std::sync::atomic::Ordering::SeqCst) {
        // Thread already spawned, just make sure it's unpaused.
        let running = INPUT_TRACKER_RUNNING
            .get_or_init(|| Arc::new(std::sync::atomic::AtomicBool::new(true)));
        running.store(true, std::sync::atomic::Ordering::SeqCst);
        return;
    }

    let counter = INPUT_COUNTER
        .get_or_init(|| Arc::new(Mutex::new(InputCounter::default())))
        .clone();
    let running = INPUT_TRACKER_RUNNING
        .get_or_init(|| Arc::new(std::sync::atomic::AtomicBool::new(true)))
        .clone();

    let poll_counter = Arc::clone(&counter);
    let poll_running = Arc::clone(&running);

    thread::spawn(move || {
        let device_state = DeviceState::new();
        let mut last_mouse = device_state.get_mouse().coords;
        let mut last_keys: HashSet<Keycode> = device_state.get_keys().into_iter().collect();

        // X11 fallback state (Linux only) — use a persistent display connection.
        #[cfg(target_os = "linux")]
        let x11_display = unsafe {
            let dpy = x11::xlib::XOpenDisplay(std::ptr::null());
            if dpy.is_null() { None } else { Some(dpy) }
        };
        #[cfg(target_os = "linux")]
        let mut last_x11_pos: Option<(i32, i32)> = {
            if let Some(dpy) = x11_display {
                get_mouse_pos_x11_with_display(dpy)
            } else {
                get_mouse_pos_shell_xdotool()
            }
        };

        loop {
            if !poll_running.load(std::sync::atomic::Ordering::SeqCst) {
                // Paused — sleep longer and don't poll input devices.
                thread::sleep(Duration::from_millis(500));
                // Reset baseline so we don't get phantom deltas on resume.
                last_mouse = device_state.get_mouse().coords;
                last_keys = device_state.get_keys().into_iter().collect();
                #[cfg(target_os = "linux")]
                { last_x11_pos = None; }
                continue;
            }

            // Catch panics so a single broken device_query call doesn't kill the thread forever.
            let poll_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mouse = device_state.get_mouse().coords;
                let keys_now_vec = device_state.get_keys();
                let keys_now: HashSet<Keycode> = keys_now_vec.into_iter().collect();
                (mouse, keys_now)
            }));

            match poll_result {
                Ok((mouse, keys_now)) => {
                    if let Ok(mut locked) = poll_counter.lock() {
                        #[allow(unused_mut)]
                        let mut mouse_moved = mouse != last_mouse;

                        // If device_query says no-move but X11 says moved, trust X11.
                        #[cfg(target_os = "linux")]
                        if !mouse_moved {
                            let current = x11_display.and_then(|dpy| get_mouse_pos_x11_with_display(dpy))
                                .or_else(get_mouse_pos_shell_xdotool);
                            if let Some(xy) = current {
                                if last_x11_pos.map_or(true, |last| xy != last) {
                                    mouse_moved = true;
                                }
                                last_x11_pos = Some(xy);
                            }
                        }

                        if mouse_moved {
                            locked.mouse_moves += 1;
                        }

                        for key in &keys_now {
                            if !last_keys.contains(key) {
                                locked.key_presses += 1;
                            }
                        }
                    }

                    last_mouse = mouse;
                    last_keys = keys_now;
                }
                Err(_) => {
                    eprintln!("[InputTracker] Panic while polling input devices; retrying next cycle");
                }
            }

            thread::sleep(Duration::from_millis(100));
        }
    });

    // Supplement device_query with an event-based keyboard hook (rdev).
    // device_query polls the current key state every 100ms and frequently
    // misses quick key presses, so the dashboard shows zero keyboard activity.
    let kb_counter = Arc::clone(&counter);
    let kb_running = Arc::clone(&running);
    thread::spawn(move || {
        let cb = move |event: rdev::Event| {
            if !kb_running.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            if let rdev::EventType::KeyPress(_) = event.event_type {
                if let Ok(mut locked) = kb_counter.lock() {
                    locked.key_presses += 1;
                }
            }
        };
        if let Err(e) = rdev::listen(cb) {
            eprintln!("[InputTracker] rdev keyboard listener failed: {:?}", e);
        }
    });

    // Re-open X11 display for subsequent connections
    #[cfg(target_os = "linux")]
    fn get_mouse_pos_x11_with_display(display: *mut x11::xlib::Display) -> Option<(i32, i32)> {
        unsafe {
            let mut root: x11::xlib::Window = std::mem::zeroed();
            let mut child: x11::xlib::Window = std::mem::zeroed();
            let mut root_x: i32 = 0;
            let mut root_y: i32 = 0;
            let mut win_x: i32 = 0;
            let mut win_y: i32 = 0;
            let mut mask: u32 = 0;
            let ret = x11::xlib::XQueryPointer(
                display, x11::xlib::XDefaultRootWindow(display),
                &mut root, &mut child,
                &mut root_x, &mut root_y,
                &mut win_x, &mut win_y,
                &mut mask,
            );
            if ret != 0 { Some((root_x, root_y)) } else { None }
        }
    }
}

fn stop_global_input_tracker() {
    let running = INPUT_TRACKER_RUNNING
        .get_or_init(|| Arc::new(std::sync::atomic::AtomicBool::new(false)));
    running.store(false, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn get_and_reset_input_counts() -> Result<InputCounts, String> {
    let counter = INPUT_COUNTER
        .get_or_init(|| Arc::new(Mutex::new(InputCounter::default())))
        .clone();

    let mut locked = counter.lock().map_err(|err| err.to_string())?;
    let out = InputCounts {
        mouse_moves: locked.mouse_moves,
        key_presses: locked.key_presses,
    };

    eprintln!(
        "[InputTracker] Retrieved counts: mouse={}, keys={}",
        out.mouse_moves, out.key_presses
    );

    locked.mouse_moves = 0;
    locked.key_presses = 0;

    Ok(out)
}

#[tauri::command]
fn get_last_input_idle_ms() -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    {
        unsafe {
            let mut info: LastInputInfo = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<LastInputInfo>() as u32;
            if GetLastInputInfo(&mut info) == 0 {
                return Err(format!(
                    "GetLastInputInfo failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let now = GetTickCount();
            let idle_ms = (now as u64).saturating_sub(info.dwTime as u64);
            Ok(idle_ms)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("get_last_input_idle_ms is only available on Windows".to_string())
    }
}

#[derive(serde::Deserialize, serde::Serialize, Debug)]
pub struct IpLocation {
    pub lat: f64,
    pub lon: f64,
    pub source: String,
}

#[tauri::command]
async fn get_ip_location() -> Result<IpLocation, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    // ipapi.co returns latitude/longitude fields.
    if let Ok(resp) = client.get("https://ipapi.co/json/").send().await {
        if resp.status().is_success() {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let (Some(lat), Some(lon)) = (body["latitude"].as_f64(), body["longitude"].as_f64()) {
                    return Ok(IpLocation {
                        lat,
                        lon,
                        source: "ip".to_string(),
                    });
                }
            }
        }
    }

    // Fallback to ip-api.com.
    if let Ok(resp) = client.get("http://ip-api.com/json/").send().await {
        if resp.status().is_success() {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let (Some(lat), Some(lon)) = (body["lat"].as_f64(), body["lon"].as_f64()) {
                    return Ok(IpLocation {
                        lat,
                        lon,
                        source: "ip".to_string(),
                    });
                }
            }
        }
    }

    Err("Unable to determine IP-based location".to_string())
}

#[tauri::command]
fn set_auth_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())?;
    entry.set_password(&token).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_auth_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())?;

    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn clear_auth_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())?;

    match entry.delete_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(target_os = "windows")]
fn read_window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }

        let mut buffer = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        String::from_utf16_lossy(&buffer[..copied as usize])
    }
}

#[cfg(target_os = "windows")]
fn read_process_path(hwnd: HWND) -> String {
    unsafe {
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        if process_id == 0 {
            return String::new();
        }

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if handle == null_mut() {
            return String::new();
        }

        let mut buffer = vec![0u16; 2048];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(handle);

        if ok == 0 || size == 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buffer[..size as usize])
    }
}

#[cfg(target_os = "windows")]
fn get_browser_url_uia(hwnd: HWND, app_name: &str) -> Option<String> {
    let lower_app = app_name.to_lowercase();
    if !["chrome", "chrome.exe", "msedge", "msedge.exe", "brave", "brave.exe", "firefox", "firefox.exe"].contains(&lower_app.as_str()) {
        return None;
    }

    use uiautomation::UIAutomation;
    use uiautomation::types::TreeScope;
    use uiautomation::variants::Variant;
    use uiautomation::types::ControlType;
    use uiautomation::types::UIProperty;
    use uiautomation::patterns::UIValuePattern;

    let automation = UIAutomation::new().ok()?;
    let root = automation.element_from_handle((hwnd as isize).into()).ok()?;
    let cond = automation.create_property_condition(
        UIProperty::ControlType, 
        Variant::from(ControlType::Edit as i32), 
        None
    ).ok()?;

    let edits = root.find_all(TreeScope::Descendants, &cond).ok()?;
    let mut best: Option<(i32, String)> = None;

    for edit in edits {
        let pattern = match edit.get_pattern::<UIValuePattern>() {
            Ok(pattern) => pattern,
            Err(_) => continue,
        };

        let raw_value = match pattern.get_value() {
            Ok(value) => value,
            Err(_) => continue,
        };

        let Some(url) = normalize_browser_url(&raw_value) else {
            continue;
        };

        let name = edit.get_name().unwrap_or_default().to_lowercase();
        let automation_id = edit.get_automation_id().unwrap_or_default().to_lowercase();
        let score = browser_address_bar_score(&lower_app, &name, &automation_id);

        if score > best.as_ref().map(|(current, _)| *current).unwrap_or(-1) {
            best = Some((score, url));
        }
    }

    best.map(|(_, url)| url)
}

#[cfg(target_os = "windows")]
fn browser_address_bar_score(app_name: &str, name: &str, automation_id: &str) -> i32 {
    let mut score = 0;

    if automation_id.contains("address") || automation_id.contains("omnibox") || automation_id == "edit" {
        score += 80;
    }

    if name.contains("address")
        || name.contains("search or enter web address")
        || name.contains("search or type web address")
        || name.contains("search with google or enter address")
        || name.contains("enter address")
        || name.contains("url")
    {
        score += 70;
    }

    if app_name.contains("firefox") && (name.contains("search") || name.contains("address")) {
        score += 25;
    }

    score
}

#[cfg(target_os = "windows")]
fn normalize_browser_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains(' ') || trimmed.len() > 2048 {
        return None;
    }

    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file://")
        || lower.starts_with("chrome://")
        || lower.starts_with("edge://")
        || lower.starts_with("brave://")
        || lower.starts_with("about:")
    {
        return Some(trimmed.to_string());
    }

    if looks_like_domain_or_localhost(trimmed) {
        return Some(format!("https://{}", trimmed));
    }

    None
}

#[cfg(target_os = "windows")]
fn looks_like_domain_or_localhost(value: &str) -> bool {
    let without_path = value.split(['/', '?', '#']).next().unwrap_or(value);
    let host = without_path
        .split('@')
        .last()
        .unwrap_or(without_path)
        .split(':')
        .next()
        .unwrap_or(without_path)
        .trim_matches('.');

    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }

    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() < 2 {
        return false;
    }

    let suffix = parts.last().copied().unwrap_or_default();
    suffix.len() >= 2
        && suffix.chars().all(|ch| ch.is_ascii_alphabetic())
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
                && !part.starts_with('-')
                && !part.ends_with('-')
        })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_active_window_info() -> Result<ActiveWindowInfo, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd == null_mut() {
            return Ok(ActiveWindowInfo {
                app_name: "Unknown".to_string(),
                window_title: String::new(),
                process_path: String::new(),
                browser_url: None,
            });
        }

        let window_title = read_window_title(hwnd);
        let process_path = read_process_path(hwnd);
        let app_name = Path::new(&process_path)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("Unknown")
            .to_string();

        let browser_url = get_browser_url_uia(hwnd, &app_name);

        Ok(ActiveWindowInfo {
            app_name,
            window_title,
            process_path,
            browser_url,
        })
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn get_active_window_info() -> Result<ActiveWindowInfo, String> {
    Ok(ActiveWindowInfo {
        app_name: "Unknown".to_string(),
        window_title: String::new(),
        process_path: String::new(),
        browser_url: None,
    })
}

#[tauri::command]
fn capture_screenshot() -> Result<Vec<u8>, String> {
    capture_frame_png(CompressionType::Fast, PngFilterType::Adaptive)
}

#[tauri::command]
fn capture_live_frame() -> Result<Vec<u8>, String> {
    capture_frame_png(CompressionType::Fast, PngFilterType::NoFilter)
}

#[tauri::command]
fn start_input_tracking() {
    start_global_input_tracker();
}

#[tauri::command]
fn stop_input_tracking() {
    stop_global_input_tracker();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Disable GPU hardware acceleration in WebView2 on Windows to fix issues on dual-GPU (Intel + NVIDIA) laptops.
    // This resolves issues where WebView2 hangs, freezes, or ignores clicks due to GPU composition handoff conflicts.
    #[cfg(target_os = "windows")]
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu --disable-gpu-compositing");

    // Do NOT start the global input tracker here — it creates system-wide
    // input hooks (via device_query) that can steal WM_INPUT messages from
    // the WebView2 process on Windows, making the UI completely unresponsive.
    // The tracker is started lazily by the frontend on clock-in.

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Create main window programmatically to enforce WebView2 GPU configurations
            // and work around hit-test region bugs on dual-GPU systems on Windows.
            use tauri::webview::WebviewWindowBuilder;
            use tauri::WebviewUrl;

            let app_icon = app.default_window_icon().cloned().or_else(|| {
                tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")).ok()
            });

            let mut window_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("TeamLens for Linux")
                .inner_size(360.0, 720.0)
                .min_inner_size(360.0, 720.0)
                .max_inner_size(360.0, 720.0)
                .decorations(false)
                .resizable(true)
                .maximizable(false)
                .center()
                .focused(true)
                .disable_drag_drop_handler();

            if let Some(ref icon) = app_icon {
                window_builder = window_builder.icon(icon.clone())?;
            }

            #[cfg(target_os = "windows")]
            let window_builder = window_builder.additional_browser_args("--disable-gpu --disable-gpu-compositing");

            if let Ok(window) = window_builder.build() {
                let _ = window.set_ignore_cursor_events(false);
                let _ = window.show();
                let _ = window.set_focus();

                // Always open devtools in debug builds for diagnosis.
                #[cfg(debug_assertions)]
                window.open_devtools();

                // WebView2 on Windows sometimes needs a delayed re-focus
                // after the compositor finishes its first paint.
                let win_clone = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(500));
                    let _ = win_clone.set_focus();
                });
            }

            // Setup System Tray
            let quit_i = MenuItem::with_id(app, "quit", "Quit TeamLens", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Open TeamLens for Linux", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app_icon {
                tray_builder = tray_builder.icon(icon);
            }

            let _tray = tray_builder.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            set_auth_token,
            get_auth_token,
            clear_auth_token,
            get_and_reset_input_counts,
            get_last_input_idle_ms,
            get_ip_location,
            get_active_window_info,
            capture_screenshot,
            capture_live_frame,
            start_input_tracking,
            stop_input_tracking
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
