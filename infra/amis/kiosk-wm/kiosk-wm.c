#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

#define ACTIVITY_FILE "/run/spore/x11-last-activity"

static void record_activity(void) {
    mkdir("/run/spore", 0755);
    int fd = open(ACTIVITY_FILE, O_WRONLY | O_CREAT, 0644);
    if (fd >= 0) close(fd);
    utimes(ACTIVITY_FILE, NULL);
}

static void fill_window(Display *dpy, Window win, Window root, int w, int h, Atom motif_hints) {
    if (!win || win == root) return;
    long hints[5] = { 2, 0, 0, 0, 0 };
    XChangeProperty(dpy, win, motif_hints, motif_hints, 32,
                    PropModeReplace, (unsigned char *)hints, 5);
    XMoveResizeWindow(dpy, win, 0, 0, w, h);
    XRaiseWindow(dpy, win);
}

int main() {
    Display *display = XOpenDisplay(0x0);
    if (!display) return 1;

    int screen = DefaultScreen(display);
    Window root = DefaultRootWindow(display);

    int width  = DisplayWidth(display, screen);
    int height = DisplayHeight(display, screen);
    fprintf(stderr, "kiosk-wm: %dx%d, activity file: %s\n",
            width, height, ACTIVITY_FILE);

    /* RandR for display resize events */
    int rr_event_base, rr_error_base;
    int has_rr = XRRQueryExtension(display, &rr_event_base, &rr_error_base);
    if (has_rr) {
        XRRSelectInput(display, root, RRScreenChangeNotifyMask);
        fprintf(stderr, "kiosk-wm: RandR events enabled\n");
    }

    XSelectInput(display, root,
        SubstructureNotifyMask | SubstructureRedirectMask |
        KeyPressMask | ButtonPressMask | PointerMotionMask);

    XGrabKey(display, AnyKey, AnyModifier, root, False, GrabModeAsync, GrabModeAsync);
    XGrabButton(display, AnyButton, AnyModifier, root, False,
                ButtonPressMask, GrabModeAsync, GrabModeAsync, None, None);

    Atom motif_hints = XInternAtom(display, "_MOTIF_WM_HINTS", False);

    /* Track managed windows so we can re-fill them on resize */
    Window managed[64];
    int n_managed = 0;

    record_activity();

    for (;;) {
        XEvent ev;
        XNextEvent(display, &ev);

        /* RandR screen change — update dimensions and re-fill all windows */
        if (has_rr && ev.type == rr_event_base + RRScreenChangeNotify) {
            XRRUpdateConfiguration(&ev);
            width  = DisplayWidth(display, screen);
            height = DisplayHeight(display, screen);
            fprintf(stderr, "kiosk-wm: display resized to %dx%d\n", width, height);
            for (int i = 0; i < n_managed; i++) {
                fill_window(display, managed[i], root, width, height, motif_hints);
            }
            continue;
        }

        /* Activity events */
        if (ev.type == KeyPress || ev.type == ButtonPress || ev.type == MotionNotify) {
            record_activity();
            /* Pass through key/button events to the focused window */
            if (ev.type == ButtonPress) XAllowEvents(display, ReplayPointer, CurrentTime);
            continue;
        }

        Window win = 0;

        if (ev.type == MapRequest) {
            win = ev.xmaprequest.window;
            XMapWindow(display, win);
        } else if (ev.type == CreateNotify) {
            win = ev.xcreatewindow.window;
        } else if (ev.type == ConfigureNotify) {
            XConfigureEvent ce = ev.xconfigure;
            if (ce.x != 0 || ce.y != 0 ||
                ce.width != width || ce.height != height) {
                win = ce.window;
            }
        } else if (ev.type == ConfigureRequest) {
            win = ev.xconfigurerequest.window;
        }

        if (win && win != root) {
            fill_window(display, win, root, width, height, motif_hints);
            /* Track for resize events */
            if (n_managed < 64) {
                int found = 0;
                for (int i = 0; i < n_managed; i++)
                    if (managed[i] == win) { found = 1; break; }
                if (!found) managed[n_managed++] = win;
            }
        }
    }

    return 0;
}
