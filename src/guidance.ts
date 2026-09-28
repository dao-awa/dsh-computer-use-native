/**
 * The system-prompt section that teaches the model how to drive the desktop.
 *
 * Tools alone are not enough. The failure mode of vision-driven desktop control
 * is not a broken tool but a stale assumption: the model screenshots, thinks,
 * takes another action, and then clicks a coordinate from an image that no
 * longer describes the screen. This text exists to make the recency requirement
 * explicit and to set the verification habit.
 *
 * @module dsh-computer-use-native/guidance
 */

/** The guidance injected as the computer-use system-prompt section. */
export const GUIDANCE = `You can see and operate the Windows desktop through screenshots.

How the tools relate:

- computer_screenshot returns an image plus a viewport id. Coordinates you give the input tools are measured on that image, in image pixels. The tools convert them to screen coordinates; never scale them yourself.
- computer_window lists what is open, reports one window's geometry, and raises a window. Use it first when you do not know what is on screen.
- computer_click, computer_move, computer_scroll, and computer_drag all act at a point from the most recent screenshot.
- computer_type sends Unicode text; computer_key sends keys and chords such as "ctrl+s".

How input is delivered, and why it matters:

Input takes one of two routes, chosen by the dispatch parameter. The default is "background", which posts window messages straight to the window the screenshot came from. That window is never raised and the real cursor never moves, so a person using the machine keeps their focus while you work. The cost is that a window may ignore a posted message. "foreground" raises the target and moves the real cursor, which every window receives, at the cost of taking the desktop over.

Prefer "background" unless it fails. If an action reports that the target refused the message, or a fresh screenshot shows nothing happened, retry that step with dispatch="foreground".

Rules that keep the loop correct:

1. Screenshot immediately before acting. A screenshot is a snapshot of a moving desktop; other windows, timers, and the user all change it. A coordinate is only trustworthy for the capture it was measured on. Input tools refuse coordinates from a window that has since moved.
2. Verify from a fresh screenshot after each action that changes state. A delivered message is not evidence that anything happened. Do not chain several state-changing actions on one screenshot.
3. Read the image before choosing a point. Text, buttons, and fields are visible in the image even inside Chromium, WebView2, and Electron windows that expose no accessible controls.
4. If a screenshot reports a near-uniform frame, the capture failed. Bring the window forward with computer_window focus, then screenshot again.
5. Prefer typing over clicking through long menus, and prefer keyboard shortcuts for anything you would otherwise do with several precise clicks.
6. Clicking a control that needs keyboard focus, such as a text field, makes the window activate itself even on the background route. The result tells you when that happened, so you can tell whether you disturbed the user.
7. Type into a field only after clicking it, because posted characters reach whatever holds focus inside the window. Clicking a background window's field also gives that window focus for the characters that follow.

If a window will not come forward on the foreground route, ask the user to click it once. Windows refuses programmatic activation in some states and repeated attempts do not help.`
