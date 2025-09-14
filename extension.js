
/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const GETTEXT_DOMAIN = 'GNOME Session Save and Restore';

const ByteArray = imports.byteArray;
const { GObject, St, Meta, GLib, Gio, Shell } = imports.gi;
const { main: Main, panelMenu: PanelMenu, popupMenu: PopupMenu } = imports.ui;
const ExtensionUtils = imports.misc.extensionUtils;

const Gettext = imports.gettext.domain(GETTEXT_DOMAIN);
const _ = Gettext.gettext;

// Global settings:
let opt = {
    filename: GLib.get_home_dir() + '/.config/gnome-session/session.ini',
    debug: 3,
    // Applications that manage their own session restore:
    self_managed: [
        'firefox',
        'Google-chrome',
    ],
};

/* ToDo:
    self_managed: LibreOffice (sometimes?)
    Save settings in the session.ini file so that they can be modified there
    Offer auto-save on window create/move/resize/close and auto-restore on GNOME startup
    DFS() for >12(?) windows

    journalctl -f GNOME_SHELL_EXTENSION_UUID=session@research-lab.ca -q --output=json --all | jq --unbuffered -r '"\(.["__REALTIME_TIMESTAMP"] | tonumber / 1000000 | todateiso8601 | sub("Z$"; "")): \(.MESSAGE)"' | tee journalctl

    Impress opening dialog blocks all other LibreOffice launches! (sometimes?)
        Nautilus dialog does not block other launches.
*/

function debug(level, entry) {
    const levels = {
        0: 'ERROR',
        1: 'WARN',
        2: 'INFO',
        3: 'DETAIL',
        4: 'DEBUG',
    };

    if (level === 0) {
        if (typeof entry === 'string') entry = new Error(entry);
        log(`${levels[level]}: ${entry.message}\n${entry.stack}`);
        Main.notify(_('Runtime error'), _(entry.message), null);
        throw entry;
    } else if (level <= opt.debug) {
        log(`${levels[level]}: ${entry}`);
    }
}

// A Desktop consists of a list of windows and their properties:
class Desktop {
    constructor(mode='current') {
        if (mode === 'restore') {
            this.windows = this._restore();
        } else {
            this.windows = this._current();
        }
        this._add_window_extras();
        debug(4, `windows = [${mode}]: ${JSON.stringify(this.windows, (key, value) => key === 'window' ? undefined : value, 2)}`);
        debug(3, `Loaded ${mode}`);
    }

    _current() {
        let meta_windows = global.get_window_actors().map(actor => actor.meta_window);
        meta_windows = meta_windows.filter(window => normal(window));

        let windows = {};
        meta_windows.forEach(window => {
            window = this._get_window_details(window);
            windows[window.id] = window;
        });

        return windows;
    }

    _restore() {
        let content = GLib.file_get_contents(opt.filename)[1];
        content = JSON.parse(ByteArray.toString(content));
        delete content.opt;

        return content;
    }

    save() {
        let content = this._del_window_extras();
        content.opt = opt;
        content = JSON.stringify(content, null, 2);
        GLib.file_set_contents(opt.filename, content);

        Main.notify(_('Session saved'), _(`Saved session to ${opt.filename}`), null);
        debug(3, `Saved windows to ${opt.filename}`);

        return true;
    }

    _get_window_details(window) {
        let rect = window.get_frame_rect();
        let pid = window.get_pid();
        let app = Shell.WindowTracker.get_default().get_window_app(window);
        app = app ? app.get_app_info() : null;

        return {
            id: window.get_stable_sequence(),
            class: ( app ? app.get_startup_wm_class() : null ) || window.get_wm_class(),
            title: window.get_title(),
            workspace: window.get_workspace().index() || 0,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            state: this._get_window_state(window),
            pid: pid,
            comm: this._get_comm(pid, app),
            window: window,
        };
    }

    _get_window_state(window) {
        let state = {};

        if (window.minimized) {
            state.minimized = true;
        }
        if (window.get_maximized() === Meta.MaximizeFlags.BOTH) {
            state['maximized-horizontal'] = true;
            state['maximized-vertical'] = true;
        } else if (window.get_maximized() === Meta.MaximizeFlags.HORIZONTAL) {
            state['maximized-horizontal'] = true;
        } else if (window.get_maximized() === Meta.MaximizeFlags.VERTICAL) {
            state['maximized-vertical'] = true;
        }
        if (window.is_fullscreen()) {
            state.fullscreen = true;
        }

        if (window.is_above()) {
            state.above = true;
        }        
        if (window.is_on_all_workspaces()) {
            state.sticky = true;
        }
        if (window.has_focus()) {
            state.focused = true;
        }

        return state;
    }

    _get_comm(pid, app) {
        let command = get_commandline(app); // From app's .desktop file
        let comm = get_pid_comm(pid);       // From /proc/pid/cmdline

        // If command is null, then use comm:
        if (!command) return comm;

        // If command contains %X and comm matches substitutions, then use comm:
        if (command.includes(' %')) {
            let commstr = this._args_to_command(comm);
            let result = compare_command_commstr(command, commstr);
            debug(4, `_get_comm(): ${command} vs ${commstr} = ${result}`);
            if (result) return comm;
        }

        // Otherwise, use command with %X removed:
        return command.split(' ').filter(arg => !arg.startsWith('%'));

        // Get command line arguments from app's .desktop file:
        function get_commandline(app) {
            if (!app) return null;
            try { // First look for a new-window Exec entry
                let file = new GLib.KeyFile();
                file.load_from_file(app.get_filename(), GLib.KeyFileFlags.NONE);
                return file.get_string('Desktop Action new-window', 'Exec');
            } catch (e) {
                return app.get_commandline();
            }
        }

        // Get command line arguments from /proc/pid/cmdline:
        function get_pid_comm(pid) {
            let content = GLib.file_get_contents(`/proc/${pid}/cmdline`)[1];
            // Arguments are null-byte (\0) separated:
            let command = [];
            let s = 0;
            for (let c = 0; c < content.length; c++) {
                if (content[c] === 0) {
                    command.push(ByteArray.toString(content.slice(s, c)));
                    s = c + 1;
                }
            }
            return [...command[0].split(' '), ...command.slice(1)];
        }

        // Convert command into a regex pattern and see if commstr matches it:
        function compare_command_commstr(command, commstr) {
            let pattern = '';
            const regex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"'\s]+/g; // argument
            let token;
            while ((token = regex.exec(command)) !== null) {
                // In .desktop file Exec: %f/%u = 1 argument; %F/%U = multiple arguments
                if (/^%[fu]$/i.test(token[0])) {
                    pattern += '(?:\\s+(?:' + regex.source + '))';
                    if (/^%[FU]$/.test(token[0])) pattern += '*';
                    pattern += '?';
                } else {
                    if (pattern) pattern += '\\s+';
                    pattern += token[0].replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                }
            }
            pattern = '^'+pattern+'$';
            return new RegExp(pattern).test(commstr);
        }
    }

    _args_to_command(comm) {
        return comm.map(arg => /[\s"'\\]/.test(arg) ? '"' + arg.replace(/"/g, '\\"') + '"' : arg).join(' ');
    }

    _add_window_extras() {
        // Some properties are not saved; derive window extras:
        for (let window of Object.values(this.windows)) {
            window.group = `${window.pid} ${window.class}`;
            window.geometry = `${window.rect.x},${window.rect.y}+${window.rect.width}x${window.rect.height}`;
            window.command = this._args_to_command(window.comm);

            [ 'minimized',
              'maximized-horizontal',
              'maximized-vertical',
              'fullscreen',
              'above',
              'sticky',
              'focused',
            ].forEach(state => {
                window.state[state] = window.state[state] || false;
            });
        }
    }

    _del_window_extras() {
        let cleaned = {};
        for (let [id, window] of Object.entries(this.windows)) {
            let _window = Object.assign({}, window);

            delete _window.group;
            delete _window.geometry;
            delete _window.command;
            delete _window.window;

            _window.state = Object.assign({}, _window.state);
            for (let key of Object.keys(_window.state)) {
                if (!_window.state[key]) delete _window.state[key];
            }

            cleaned[id] = _window;
        }
        return cleaned;
    }
}

// A Session consists of 2 Desktops: A source (current) and a target (restore)
class Session {
    constructor() {
        this.restore = new Desktop('restore').windows;
        this.current = new Desktop('current').windows;

        this.stat = { launches: {}, events: {} };
    }

    match_by_id() {
        debug(3, 'Matching by ID...');

        for (let restore of Object.values(this.restore)) {
            restore.match = null;

            let current = this.current[restore.id];
            if (current && restore.class   === current.class &&
                           restore.pid     === current.pid   &&
                           restore.command === current.command) {
                debug(3, `Window exists: ${restore.class} (${restore.id}) pid=${restore.pid}`);
                restore.match = current.id;
                current.match = true;
            }
        }
    }

    match_by_properties() {
        debug(3, 'Matching by properties...');

        // First, score each potential restore<->current match:
        let scores = {};
        for (let restore of Object.values(this.restore)) {
            if (restore.match) continue;
            restore._match = null;

            for (let current of Object.values(this.current)) {
                if (current.match) continue;

                // Potential matches must have the same class:
                if (restore.class !== current.class) continue;
                // and at least 1 of title, command, or pid match:
                let score = 0;
                score += Math.floor(levenshtein(restore.title, current.title) * 10);
                if (restore.pid       === current.pid      ) score += 6;
                if (restore.command   === current.command  ) score += 6;
                if (restore.workspace === current.workspace) score += 2;
                if (restore.geometry  === current.geometry ) score += 1;

                if (score > 5) {
                    scores[restore.class] = scores[restore.class] || {};
                    scores[restore.class][restore.id] = scores[restore.class][restore.id] || {};
                    scores[restore.class][restore.id][current.id] = score;
                }
            }
        }
        debug(4, `scores = ${JSON.stringify(scores, null, 2)}`);

        // Next, find the best overall restore<->current match set (map):
        for (let group of Object.keys(scores)) {
            debug(3, `Group ${group} (${Object.keys(scores[group]).length} windows)...`);

            let [score, map] = depth_first_search ( scores[group] );
            // This is basically a travelling salesman problem, solved using a
            // recursive depth-first search algorithm... It goes through every
            // possible restore<->current set (map) combination, to find which
            // has the highest total score.
            function depth_first_search(group, _rid={}, _cid={}) {
                // Pick the next restore window ID:
                let rid = Object.keys(group).find(r => !_rid[r]) || null;
                if (!rid) return [0, _rid];

                let best = { score: 0 };

                // No match case (ie, fewer current windows than restore session):
                let NULL = (Object.keys(group).length - Object.keys(group[rid]).length
                            > Object.values(_rid).filter(n => /^NULL#\d+$/.test(n)).length)
                           ? [`NULL#${Object.keys(_rid).length}`] : [];

                // Pick the next current window ID:
                for (let cid of [...Object.keys(group[rid]), ...NULL]) {
                    if (_cid[cid]) continue;
                    _cid[cid] = true;
                    _rid[rid] = cid;
                    let _score = /^NULL#\d+$/.test(cid) ? 1 : group[rid][cid];

                    debug(4, ('  '.repeat(Object.keys(_rid).length)) + `Trying ${rid} + ${cid}...`);
                    let [score, map] = depth_first_search(group, {..._rid}, {..._cid});
                    best.last = !score; // Only care about score on the last rid
                    debug(4, ('  '.repeat(Object.keys(_rid).length)) + `Result = ${_score}`
                           + (score ? ` + ${score} (best) = ${_score + score}` : ''));
                    score += _score;
                    if (score > best.score) {
                        best = {
                            rid: map,
                            cid: cid,
                            last: best.last,
                            score: score
                        };
                    }

                    delete _cid[cid];
                }

                return [best.score, best.score ? best.rid : _rid];
            }

            debug(3, `Best match score = ${score}`);

            // Finally, record the resulting set (map):
            for (let id of Object.keys(map)) {
                if (/^NULL#\d+$/.test(map[id])) continue;

                let restore = this.restore[id];
                let current = this.current[map[id]];
                debug(3, `Window matches: ${restore.class} (${restore.id})`
                       + ` = ${current.class} (${current.id}) pid=${current.pid}`
                       + ` score=${scores[group][restore.id][current.id]}`);
                // Mark as tentative match:
                restore._match = current.id;
            }
        }

        function levenshtein(str1, str2) {
            if (str1 == null) str1 = '';
            if (str2 == null) str2 = '';
            let matrix = [];
            
            // Initialize first row and column
            for (let i = 0; i <= str2.length; i++) {
                matrix[i] = [i];
            }
            for (let j = 0; j <= str1.length; j++) {
                matrix[0][j] = j;
            }
            
            // Fill the matrix
            for (let i = 1; i <= str2.length; i++) {
                for (let j = 1; j <= str1.length; j++) {
                    if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                        matrix[i][j] = matrix[i - 1][j - 1];
                    } else {
                        matrix[i][j] = Math.min(
                            matrix[i - 1][j - 1] + 1, // substitution
                            matrix[i][j - 1] + 1,     // insertion
                            matrix[i - 1][j] + 1      // deletion
                        );
                    }
                }
            }
            
            let distance = matrix[str2.length][str1.length];        
            let maxLength = Math.max(str1.length, str2.length);
            return (maxLength - distance) / maxLength;
        }
    }

    restore_missing() {
        debug(3, `Restoring missing windows...`);

        for (let restore of Object.values(this.restore)) {
            if (!this.stat.launches[restore.group]) {
                this.stat.launches[restore.group] = {
                    id: restore.group,
                    comm: restore.comm,
                    class: restore.class,
                    matched: [],
                    remaining: [],
                    _matched: 0,
                };
            }
            if ( restore.match ) {
                this.stat.launches[restore.group].matched.push(restore);
            } else {
                this.stat.launches[restore.group].remaining.push(restore);
            }
        }

        // The launch processing loop is event-driven:
        this.stat.created = global.display.connect('window-created', (display, window) => {
            debug(4, `Window created`);
            let shown = window.connect('shown', () => {
                try {
                    window.disconnect(shown); // Only handle once
                    delete this.stat.events[shown];
                    if (!this.stat.created) return; // Block obsolete events already in progress
                    if (!normal(window)) return;
                    let id = window.get_stable_sequence();
                    if (this.current[id]) return; // Window already processed before shown...
                    this.current = new Desktop('current').windows;
                    window = this.current[id];
                    debug(3, `Window shown: ${window.class} (${window.id}) pid=${window.pid}`);
                    this.match_by_properties();
                    this._process_launches();
                } catch(error) {
                    debug(0, error);
                }
            });
            this.stat.events[shown] = window;
        });

        this._process_launches();
    }

    _process_launches() {
        let wait = 0;
        debug(4, `launches = ${JSON.stringify(this.stat.launches, (key, value) => /^(?:matched|remaining)$/.test(key) ? value.map(restore => restore.id) : value, 2)}`);
        for (let launch of Object.values(this.stat.launches)) {
            // Count current windows matched:
            let _matched = launch.remaining.filter(restore => restore._match).length;

            if (!launch.remaining.length) {
                launch.pid = '-'; // No launch needed
                delete this.stat.launches[launch.id];
            } else if ( launch.MSPW && _matched < launch.remaining.length ) { // Multiple single-pid windows
                if ( _matched <= launch._matched ) {
                    debug(3, `Launches pending: ${launch.class} (${launch.pid})`
                           + `x${launch.remaining.length - _matched} -> waiting`);
                    wait += launch.remaining.length - _matched;
                } else {
                    debug(3, `Some windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> waiting`);
                    wait += launch.remaining.length - _matched;
                }
            } else if ( _matched <= launch._matched ) { // No new matches
                if (!launch.pid) {
                    // Handled later
                } else if ( launch.pid !== '-' ) {
                    debug(3, `Launch pending: ${launch.class} (${launch.pid}) -> waiting`);
                    wait++;
                }
            } else if ( _matched < launch.remaining.length ) { // Some new matches
                if (!launch.pid) {
                    // Handled later
                } else if (launch.pid !== '-') {
                    if (opt.self_managed.some(app => app === launch.class)) { // Only launch once per self_managed application
                        debug(3, `Launch self-managed: ${launch.class} (${launch.pid})`
                               + ` matched ${_matched} of ${launch.remaining.length} -> give up`);
                        launch.pid = '-';
                    } else {
                        debug(3, `Launch insufficient: ${launch.class} (${launch.pid})`
                               + ` matched ${_matched} of ${launch.remaining.length} -> try again`);
                        launch.pid = null;
                    }
                } else {
                    debug(3, `Some windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> gave up`);
                }
            } else { // All remaining windows matched
                if (!launch.pid) {
                    launch.pid = '-'; // No launch needed
                } else if (launch.pid !== '-') {
                    debug(3, `Launch successful: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> launch done`);
                } else {
                    debug(3, `All windows matched: ${launch.class} (${launch.pid})`
                           + ` matched ${_matched} of ${launch.remaining.length} -> launch done`);
                }

                for (let restore of launch.remaining) {
                    restore.match = restore._match;
                }
                delete this.stat.launches[launch.id];
            }

            if (!launch.pid) {
                // Multiple single-pid windows (MSPW): Many applications manage
                // multiple windows using a single process. Thus, if a launched
                // process died while creating a single window that shares its
                // pid with all other windows of its class, then it's probably
                // safe to launch all the remaining windows.
                if ( launch.died && _matched == launch._matched+1 && launch.matched.length + _matched > 1 ) {
                    let pid = null;
                    for (let restore of [...launch.matched, ...launch.remaining]) {
                        let id = restore.match || restore._match;
                        if (!id) continue;
                        if (pid === null) {
                            pid = this.current[id].pid;
                        } else if (pid !== this.current[id].pid) {
                            pid = '-';
                            break;
                        }
                    }
                    if ( pid !== '-' ) {
                        launch.pid = pid;
                        launch.MSPW = true;
                        debug(4, `Multiple single-pid windows: ${launch.class} (${launch.pid})`);
                    }
                }
                delete launch.died;

                for (let i = 1; i <= (!launch.MSPW ? 1 : launch.remaining.length - _matched); i++) {
                    let pid = null;
                    try {
                        pid = GLib.spawn_async(
                            null,
                            launch.comm,
                            null,
                            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                            null
                        )[1];
                    } catch (e) {
                        debug(1, `Launch failed: ${launch.class} ${e.message}`);
                        launch.pid = '-';
                        delete this.stat.launches[launch.id]; // Launch done
                        break;
                    }
                    if ( !launch.MSPW ) launch.pid = pid;

                    let died = GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (pid, status) => {
                        try{
                            delete this.stat.events[died];
                            // Processes that die with status = 0 are probably fine:
                            debug(4, `Process died: ${launch.class} (${pid})`);
                            if (status) {
                                debug(3, `Launch died: ${launch.class} (${launch.pid})`
                                       + ` exit = ${(status >> 8) & 0xff}; signal = ${status & 0x7f} -> give up`);
                                launch.pid = '-';
                            }
                            launch.died = true;
                        } catch(error) {
                            debug(0, error);
                        }
                    });
                    this.stat.events[died] = null;

                    wait++;
                }

                if ( launch.pid !== '-' ) {
                    if ( !launch.MSPW ) {
                        debug(2, `Launched window: ${launch.class} (${launch.pid})`);
                    } else {
                        debug(2, `Launched windows: ${launch.class} (${launch.pid})`
                               + `x${launch.remaining.length - _matched}`);
                    }

                    if (!launch.launched) { // First launch attempt
                        for (let restore of launch.remaining) {
                            restore.pid = launch.pid; // Helps matching
                        }
                        launch.launched = true;
                    }
                }
            }

            if (_matched > launch._matched) launch._matched = _matched;
        }

        debug(3, `${wait} pending launches.`);
        if (wait) {
            let load = Gio.File.new_for_path('/proc/loadavg').load_contents(null)[1];
            load = parseFloat(ByteArray.toString(load).split(' ')[0]) || 1.0;
            wait = Math.round(5 + (Math.log(wait)/Math.log(20)) * (25 + 13 * load) + 5 * load);
            debug(4, `Waiting maximum ${wait} more seconds.`);

            if (this.stat.tired) GLib.Source.remove(this.stat.tired);
            this.stat.tired = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
                try {
                    debug(3, `Tired of waiting for launches...`);
                    this.current = new Desktop('current').windows;
                    this._finish_restore();
                } catch(error) {
                    debug(0, error);
                }
            });
        } else { // No pending launches
            if (this.stat.tired) GLib.Source.remove(this.stat.tired);
            this._finish_restore();
        }
    }

    _finish_restore() {
        global.display.disconnect(this.stat.created);
        this.stat.created = null; // Block obsolete events already in progress
        for (let event of Object.keys(this.stat.events)) {
            if (!this.stat.events[event]) {
                GLib.Source.remove(event);
            } else {
                this.stat.events[event].disconnect(event);
            }
        }

        // If there were launches, then there was enough time for the user to
        // have opened/closed windows in the interim; rematch:
        if (this.stat.tired) {
            this.match_by_id();
            this.match_by_properties();
        }
        this.restore_properties();
    }

    restore_properties() {
        debug(3, `Restoring window properties...`);

        let focused = null;
        for (let restore of Object.values(this.restore).sort((a, b) => a.workspace - b.workspace)) {
            restore.match = restore.match || restore._match;
            if (!restore.match) continue;
            let current = this.current[restore.match];

            if (restore.workspace !== current.workspace) {
                let wsm = global.workspace_manager;
                for (let n = wsm.get_n_workspaces(); n <= restore.workspace; n++) {
                    wsm.append_new_workspace(false, null);
                }

                current.window.change_workspace(wsm.get_workspace_by_index(restore.workspace));

                debug(2, `${current.class} (${current.id})`
                       + ` - moved workspace from ${current.workspace} => ${restore.workspace}`);
            }

            for (let state in restore.state) {
                if (restore.state[state] !== current.state[state]) {
                    switch (state) {
                        case 'minimized':
                            restore.state[state] ? current.window.minimize() : current.window.unminimize();
                            break;
                        case 'maximized-horizontal':
                            restore.state[state] ? current.window.maximize(Meta.MaximizeFlags.HORIZONTAL) : current.window.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
                            break;
                        case 'maximized-vertical':
                            restore.state[state] ? current.window.maximize(Meta.MaximizeFlags.VERTICAL) : current.window.unmaximize(Meta.MaximizeFlags.VERTICAL);
                            break;
                        case 'fullscreen':
                            restore.state[state] ? current.window.make_fullscreen() : current.window.unmake_fullscreen();
                            break;
                        case 'above':
                            restore.state[state] ? current.window.make_above() : current.window.unmake_above();
                            break;
                        case 'sticky':
                            restore.state[state] ? current.window.stick() : current.window.unstick();
                            break;
                        case 'focused':
                            if (restore.state[state]) focused = current;
                            break;
                    }

                    if (state !== 'focused') {
                        debug(2, `${current.class} (${current.id})`
                               + ` - ${state}: ${current.state[state]} => ${restore.state[state]}`);
                    }
                }
            }

            if (restore.geometry !== current.geometry) {
                current.window.move_resize_frame(true,
                    restore.rect.x, restore.rect.y,
                    restore.rect.width, restore.rect.height);

                debug(2, `${current.class} (${current.id})`
                       + ` - moved from ${current.geometry} => ${restore.geometry}`);
            }
        }

        if (focused) {
            focused.window.activate(global.get_current_time());

            debug(2, `Focused window: ${focused.class} (${focused.id})`);
        }

        Main.notify(_('Session restored'), _(`Restored session from ${opt.filename}`), null);
    }
}

// Ignore dialog, modal, and other non-windows:
function normal(window) {
    return window.get_window_type() === Meta.WindowType.NORMAL && !window.get_transient_for();
}

const Indicator = GObject.registerClass(
class Indicator extends PopupMenu.PopupSubMenuMenuItem {
    _init() {
        super._init(_('Session'));

        let icon = new St.Icon({
            icon_name: 'view-paged-rtl-symbolic',
            style_class: 'popup-menu-icon',
        });
        this.actor.insert_child_at_index(icon, 1);

        let item = new PopupMenu.PopupMenuItem(_('Save session'));
        item.connect('activate', () => {
            try {
                debug(2, `Saving session.`);
                let session = new Desktop();
                session.save();
            } catch(error) {
                debug(0, error);
            }
        });
        this.menu.addMenuItem(item);

        for (let item of [[0, 'existing'], [1, 'matching'], [2, 'missing']]) {
            let [level, desc] = item;
            item = new PopupMenu.PopupMenuItem(_(`Restore ${desc}`));
            item.connect('activate', () => {
                try {
                    debug(2, `Restoring session (${level}).`);
                    let session = new Session();
                    session.match_by_id();
                    if (level>0) session.match_by_properties();
                    if (level>1) session.restore_missing();
                    if (level<2) session.restore_properties();
                } catch(error) {
                    debug(0, error);
                }
            });
            this.menu.addMenuItem(item);
        }
    }
});

class Extension {
    constructor(uuid) {
        this._uuid = uuid;

        ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
    }

    enable() {
        this._indicator = new Indicator();
        let menu = Main.panel.statusArea.aggregateMenu.menu;
        menu.addMenuItem(this._indicator, menu.numMenuItems - 1);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}

function init(meta) {
    return new Extension(meta.uuid);
}
