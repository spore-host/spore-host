#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

#define ACTIVITY_FILE "/run/spore/x11-last-activity"

static int width, height;
static Display *dpy;
static Window root;
static Atom motif_hints;

static void touch_activity(void) {
    mkdir("/run/spore", 0755);
    int fd = open(ACTIVITY_FILE, O_WRONLY | O_CREAT, 0644);
    if (fd >= 0) close(fd);
    utimes(ACTIVITY_FILE, NULL);
}

static void fill_window(Window win) {
    if (!win || win == root) return;
    long hints[5] = { 2, 0, 0, 0, 0 };
    XChangeProperty(dpy, win, motif_hints, motif_hints, 32,
                    PropModeReplace, (unsigned char *)hints, 5);
    XMoveResizeWindow(dpy, win, 0, 0, width, height);
    XRaiseWindow(dpy, win);
}

static void fill_all(void) {
    Window parent, *children;
    unsigned int n;
    if (!XQueryTree(dpy, root, &root, &parent, &children, &n)) return;
    for (unsigned int i = 0; i < n; i++) fill_window(children[i]);
    if (children) XFree(children);
    fprintf(stderr, "kiosk-wm: filled %u windows at %dx%d\n", n, width, height);
}

int main(void) {
    dpy = XOpenDisplay(NULL);
    if (!dpy) return 1;

    int screen = DefaultScreen(dpy);
    root = DefaultRootWindow(dpy);
    width  = DisplayWidth(dpy, screen);
    height = DisplayHeight(dpy, screen);
    fprintf(stderr, "kiosk-wm: %dx%d\n", width, height);

    int rr_base, rr_err;
    int has_rr = XRRQueryExtension(dpy, &rr_base, &rr_err);
    if (has_rr) XRRSelectInput(dpy, root, RRScreenChangeNotifyMask);

    /* SubstructureNotify only — do NOT grab events (breaks app input) */
    XSelectInput(dpy, root, SubstructureNotifyMask);

    motif_hints = XInternAtom(dpy, "_MOTIF_WM_HINTS", False);

    fill_all();
    touch_activity();

    for (;;) {
        XEvent ev;
        XNextEvent(dpy, &ev);

        /* Display resized by DCV on client connect — re-fill all windows */
        if (has_rr && ev.type == rr_base + RRScreenChangeNotify) {
            XRRUpdateConfiguration(&ev);
            width  = DisplayWidth(dpy, screen);
            height = DisplayHeight(dpy, screen);
            fprintf(stderr, "kiosk-wm: resized to %dx%d\n", width, height);
            fill_all();
            touch_activity();
            continue;
        }

        /* New or moved window — fill it */
        Window win = 0;
        if (ev.type == MapNotify)
            win = ev.xmap.window;
        else if (ev.type == CreateNotify)
            win = ev.xcreatewindow.window;
        else if (ev.type == ConfigureNotify) {
            XConfigureEvent ce = ev.xconfigure;
            if (ce.x != 0 || ce.y != 0 ||
                ce.width != width || ce.height != height)
                win = ce.window;
        }
        if (win && win != root) {
            fill_window(win);
            touch_activity();
        }
    }
    return 0;
}
