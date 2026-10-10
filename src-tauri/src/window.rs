/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Enough of the window (its title-bar strip) must overlap a display for the user to grab it.
const MIN_VISIBLE_W: i64 = 120;
const MIN_VISIBLE_H: i64 = 44;

fn overlap(a_start: i64, a_len: i64, b_start: i64, b_len: i64) -> i64 {
    (a_start + a_len).min(b_start + b_len) - a_start.max(b_start)
}

/// True when the window can still be reached on at least one of the displays.
pub fn is_reachable(window: Rect, monitors: &[Rect]) -> bool {
    monitors.iter().any(|m| {
        overlap(
            window.x as i64,
            window.width as i64,
            m.x as i64,
            m.width as i64,
        ) >= MIN_VISIBLE_W
            && overlap(
                window.y as i64,
                window.height as i64,
                m.y as i64,
                m.height as i64,
            ) >= MIN_VISIBLE_H
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DISPLAY: Rect = Rect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1440,
    };

    fn win(x: i32, y: i32) -> Rect {
        Rect {
            x,
            y,
            width: 1440,
            height: 900,
        }
    }

    #[test]
    fn window_inside_a_display_is_reachable() {
        assert!(is_reachable(win(100, 100), &[DISPLAY]));
    }

    #[test]
    fn window_on_a_disconnected_display_is_not() {
        assert!(!is_reachable(win(4000, 100), &[DISPLAY]));
        assert!(!is_reachable(win(-5000, 0), &[DISPLAY]));
    }

    #[test]
    fn window_mostly_off_screen_but_grabbable_is_reachable() {
        assert!(is_reachable(win(2400, 100), &[DISPLAY]));
        assert!(!is_reachable(win(2540, 100), &[DISPLAY]));
    }

    #[test]
    fn any_display_will_do() {
        let second = Rect {
            x: 2560,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert!(is_reachable(win(3000, 50), &[DISPLAY, second]));
    }

    #[test]
    fn no_displays_means_not_reachable() {
        assert!(!is_reachable(win(0, 0), &[]));
    }
}
