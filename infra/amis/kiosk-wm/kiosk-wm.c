#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/extensions/Xrandr.h>
#include <X11/extensions/XInput2.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/select.h>
#include <string.h>

#define ACTIVITY_FILE "/run/spore/x11-last-activity"

static int width, height;
static Display *dpy;
static Window root;
static Atom motif_hints;
static Atom wm_type_normal;
static Atom wm_type_dialog;
static Atom wm_window_type;
static Atom wm_transient_for;

static void touch_activity(void) {
    mkdir("/run/spore", 0755);
    int fd = open(ACTIVITY_FILE, O_WRONLY | O_CREAT, 0644);
    if (fd >= 0) close(fd);
    utimes(ACTIVITY_FILE, NULL);
}

/* Return 1 if this is a normal top-level application window, not a dialog/popup */
static int is_main_window(Window win) {
    Atom actual_type;
    int actual_format;
    unsigned long nitems, bytes_after;
    unsigned char *data = NULL;

    /* Check _NET_WM_WINDOW_TYPE */
    if (XGetWindowProperty(dpy, win, wm_window_type, 0, 32, False,
                           XA_ATOM, &actual_type, &actual_format,
                           &nitems, &bytes_after, &data) == Success && data) {
        Atom *types = (Atom *)data;
        int result = 0;
        for (unsigned long i = 0; i < nitems; i++) {
            if (types[i] == wm_type_normal) { result = 1; break; }
            if (types[i] == wm_type_dialog) { result = 0; break; }
        }
        XFree(data);
        if (nitems > 0) return result;
    }

    /* No _NET_WM_WINDOW_TYPE — check if it has WM_TRANSIENT_FOR (dialog indicator) */
    Window transient = 0;
    if (XGetTransientForHint(dpy, win, &transient) && transient != 0) {
        return 0; /* transient = dialog/popup, don't fill */
    }

    /* Must have WM_CLASS — windows without it are internal compositor/DCV windows */
    XClassHint class_hint;
    if (!XGetClassHint(dpy, win, &class_hint)) return 0;
    int skip = (class_hint.res_class && strncmp(class_hint.res_class, "Dcv", 3) == 0) ||
               (class_hint.res_name  && strncmp(class_hint.res_name,  "dcv", 3) == 0);
    XFree(class_hint.res_name);
    XFree(class_hint.res_class);
    return skip ? 0 : 1;
}

static void fill_window(Window win) {
    if (!win || win == root) return;
    if (!is_main_window(win)) return;
    long hints[5] = { 2, 0, 0, 0, 0 };
    XChangeProperty(dpy, win, motif_hints, motif_hints, 32,
                    PropModeReplace, (unsigned char *)hints, 5);
    XMoveResizeWindow(dpy, win, 0, 0, width, height);
    XRaiseWindow(dpy, win);
    fprintf(stderr, "kiosk-wm: filled window %lu\n", win);
}

static void fill_all(void) {
    Window parent, *children;
    unsigned int n;
    if (!XQueryTree(dpy, root, &root, &parent, &children, &n)) return;
    int filled = 0;
    for (unsigned int i = 0; i < n; i++) {
        if (is_main_window(children[i])) {
            fill_window(children[i]);
            filled++;
        }
    }
    if (children) XFree(children);
    fprintf(stderr, "kiosk-wm: filled %d/%u main windows at %dx%d\n",
            filled, n, width, height);
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

    XSelectInput(dpy, root, SubstructureNotifyMask);

    /* XInput2 for passive activity monitoring */
    int xi_op, xi_ev, xi_err;
    int has_xi2 = XQueryExtension(dpy, "XInputExtension", &xi_op, &xi_ev, &xi_err);
    if (has_xi2) {
        int major = 2, minor = 0;
        if (XIQueryVersion(dpy, &major, &minor) == Success) {
            XIEventMask mask;
            unsigned char bits[4] = {0};
            mask.deviceid = XIAllMasterDevices;
            mask.mask_len = sizeof(bits);
            mask.mask = bits;
            XISetMask(bits, XI_RawMotion);
            XISetMask(bits, XI_RawKeyPress);
            XISetMask(bits, XI_RawButtonPress);
            XISelectEvents(dpy, root, &mask, 1);
            fprintf(stderr, "kiosk-wm: XInput2 activity monitoring enabled\n");
        }
    }

    motif_hints    = XInternAtom(dpy, "_MOTIF_WM_HINTS", False);
    wm_type_normal = XInternAtom(dpy, "_NET_WM_WINDOW_TYPE_NORMAL", False);
    wm_type_dialog = XInternAtom(dpy, "_NET_WM_WINDOW_TYPE_DIALOG", False);
    wm_window_type = XInternAtom(dpy, "_NET_WM_WINDOW_TYPE", False);
    wm_transient_for = XInternAtom(dpy, "WM_TRANSIENT_FOR", False);

    fill_all();
    touch_activity();

    int xfd = ConnectionNumber(dpy);

    for (;;) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(xfd, &fds);
        /* Poll every 1s to detect Xdcv display resize (RandR events unreliable) */
        struct timeval tv = { 1, 0 };
        select(xfd + 1, &fds, NULL, NULL, &tv);
        /* Check if display was resized */
        int new_w = DisplayWidth(dpy, screen);
        int new_h = DisplayHeight(dpy, screen);
        if (new_w != width || new_h != height) {
            width = new_w; height = new_h;
            fprintf(stderr, "kiosk-wm: resized to %dx%d (poll)\n", width, height);
            fill_all();
            touch_activity();
        }

        while (XPending(dpy)) {
            XEvent ev;
            XNextEvent(dpy, &ev);

            if (has_rr && ev.type == rr_base + RRScreenChangeNotify) {
                XRRUpdateConfiguration(&ev);
                width  = DisplayWidth(dpy, screen);
                height = DisplayHeight(dpy, screen);
                fprintf(stderr, "kiosk-wm: resized to %dx%d\n", width, height);
                fill_all();
                touch_activity();
                continue;
            }

            if (has_xi2 && ev.type == GenericEvent && ev.xcookie.extension == xi_op) {
                if (XGetEventData(dpy, &ev.xcookie)) {
                    touch_activity();
                    XFreeEventData(dpy, &ev.xcookie);
                }
                continue;
            }

            /* Only act on new windows appearing — not on every configure event
             * (configure events cause resize loops with Qt apps) */
            Window win = 0;
            if (ev.type == MapNotify)         win = ev.xmap.window;
            else if (ev.type == CreateNotify) win = ev.xcreatewindow.window;
            if (win && win != root) fill_window(win);
        }
    }
    return 0;
}
