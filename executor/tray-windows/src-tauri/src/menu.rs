//! The right-click menu, rebuilt from the service's answer on every poll.
//!
//! The first line is disabled and says what the icon means. Then one submenu per
//! paired executor carrying **Start** and **Stop**, then the four things that
//! are not about a particular executor. **Quit** says what it does and does not
//! do, because a tray whose Quit silently stopped a boot-time service would be
//! the single most surprising thing this application could do.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

use crate::state::{header_label, short_id, ServiceView};

pub const PAIR_ID: &str = "pair";
pub const OPEN_NESSIE_ID: &str = "open-nessie";
pub const OPEN_LOGS_ID: &str = "open-logs";
pub const QUIT_ID: &str = "quit";

const START_PREFIX: &str = "start:";
const STOP_PREFIX: &str = "stop:";

/// What a clicked menu id means. Ids carry their executor so the tray keeps no
/// selection state that could drift from what the menu is showing.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    OpenLogs,
    OpenNessie,
    Pair,
    Quit,
    Start(String),
    Stop(String),
    Unknown,
}

pub fn parse_menu_id(id: &str) -> MenuAction {
    if let Some(executor_id) = id.strip_prefix(START_PREFIX) {
        return MenuAction::Start(executor_id.to_owned());
    }
    if let Some(executor_id) = id.strip_prefix(STOP_PREFIX) {
        return MenuAction::Stop(executor_id.to_owned());
    }
    match id {
        PAIR_ID => MenuAction::Pair,
        OPEN_NESSIE_ID => MenuAction::OpenNessie,
        OPEN_LOGS_ID => MenuAction::OpenLogs,
        QUIT_ID => MenuAction::Quit,
        _ => MenuAction::Unknown,
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>, view: &ServiceView) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "header", header_label(view), false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if let ServiceView::Reachable { executors } = view {
        for executor in executors {
            let label = format!("{} — {}", short_id(&executor.executor_id), executor.daemon_status);
            let entry = Submenu::with_items(
                app,
                label,
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        format!("{START_PREFIX}{}", executor.executor_id),
                        "Start",
                        executor.daemon_status != "running",
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(
                        app,
                        format!("{STOP_PREFIX}{}", executor.executor_id),
                        "Stop",
                        executor.daemon_status == "running",
                        None::<&str>,
                    )?,
                ],
            )?;
            menu.append(&entry)?;
        }
        if !executors.is_empty() {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
    }
    menu.append(&MenuItem::with_id(app, PAIR_ID, "Pair a new executor…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, OPEN_NESSIE_ID, "Open Nessie", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, OPEN_LOGS_ID, "Open logs folder", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        QUIT_ID,
        "Quit tray (the executor service keeps running)",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::{parse_menu_id, MenuAction, OPEN_LOGS_ID, OPEN_NESSIE_ID, PAIR_ID, QUIT_ID};

    #[test]
    fn a_clicked_line_carries_the_executor_it_belongs_to() {
        assert_eq!(
            parse_menu_id("start:1f2e3d4c-0000-4000-8000-000000000001"),
            MenuAction::Start("1f2e3d4c-0000-4000-8000-000000000001".to_owned()),
        );
        assert_eq!(
            parse_menu_id("stop:1f2e3d4c-0000-4000-8000-000000000001"),
            MenuAction::Stop("1f2e3d4c-0000-4000-8000-000000000001".to_owned()),
        );
    }

    #[test]
    fn the_four_standing_entries_are_the_only_other_ones() {
        assert_eq!(parse_menu_id(PAIR_ID), MenuAction::Pair);
        assert_eq!(parse_menu_id(OPEN_NESSIE_ID), MenuAction::OpenNessie);
        assert_eq!(parse_menu_id(OPEN_LOGS_ID), MenuAction::OpenLogs);
        assert_eq!(parse_menu_id(QUIT_ID), MenuAction::Quit);
        // The disabled header can never be clicked, and anything else is a
        // menu this build did not create.
        for id in ["header", "", "uninstall", "start", "stop"] {
            assert_eq!(parse_menu_id(id), MenuAction::Unknown, "id {id:?} must be unknown");
        }
    }
}
