// @ts-nocheck
// Recovered UI controller. The original typed source was overwritten while
// repairing provider configuration; this restores the working modal, provider
// picker, and prompt-queue behavior. Type it incrementally rather than
// rewriting the controller from scratch.
import { stdin as input, stdout as output } from "node:process";
import { errorMessage } from "../errors.js";
import { color, rgb } from "../util/ansi.js";
import { readClipboard, writeClipboard } from "../util/clipboard.js";
import { handleSlashCommand, COMMANDS } from "./commands.js";
import { Editor } from "./editor.js";
import { INFINITY_ICON_WIDTH, nodeColorAt, renderInfinityIcon } from "./infinity.js";
import { KeyParser } from "./keys.js";
import { PromptQueue } from "./prompt-queue.js";
import { composeFrame } from "./screen.js";
import { Transcript } from "./transcript.js";
import { ActivityTracker, shellApprovalFor } from "./activity.js";
const PASTE_ON = "\u001b[?2004h";
const PASTE_OFF = "\u001b[?2004l";
const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";
const CURSOR_ON = "\u001b[?25h";
const CURSOR_OFF = "\u001b[?25l";
const CTRL_C_WINDOW_MS = 1500;
const TICK_MS = 50;
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
class Painter {
    out;
    previous = [];
    constructor(out) {
        this.out = out;
    }
    reset() {
        this.previous = [];
        this.out.write("\u001b[2J\u001b[H");
    }
    paint(frame) {
        const lines = frame.lines;
        let out = "";
        if (this.previous.length !== lines.length) {
            out += "\u001b[2J";
            this.previous = [];
        }
        out += CURSOR_OFF;
        for (let row = 0; row < lines.length; row++) {
            const line = lines[row] ?? "";
            if (line === this.previous[row])
                continue;
            out += `\u001b[${row + 1};1H${line}\u001b[K`;
        }
        if (frame.cursor) {
            out += `\u001b[${frame.cursor.row + 1};${frame.cursor.col + 1}H${CURSOR_ON}`;
        }
        this.out.write(out);
        this.previous = lines.slice();
    }
}
/** Full-screen interactive UI: alternate screen, transcript, composer, status. */
export class Tui {
    runtime;
    state;
    transcript = new Transcript();
    editor = new Editor();
    parser = new KeyParser();
    promptQueue = new PromptQueue();
    painter = new Painter(output);
    tracker = new ActivityTracker();
    /** Files touched during the current turn, shown in the status strip. */
    changedFiles = new Set();
    scroll = 0;
    expanded = false;
    busy;
    approval;
    frame;
    /** Command palette state. */
    paletteOpen = false;
    paletteFilter = "";
    paletteSelected = 0;
    /** Model picker state. */
    modelPickerOpen = false;
    modelPickerFilter = "";
    modelPickerSelected = 0;
    modelPickerModels = [];
    modelPickerLoading = false;
    modelPickerError;
    pendingModelSwitch;
    /** Provider picker and custom provider form state. */
    providerPickerOpen = false;
    providerPickerFilter = "";
    providerPickerSelected = 0;
    providerPickerProviders = [];
    providerAddMode = false;
    providerAddInput = "";
    providerAddError = "";
    providerCredentialMode = false;
    providerCredentialProvider;
    providerKeyInput = "";
    providerEndpointMode = false;
    providerEndpointInput = "";
    providerEndpointOverrides = new Map();
    /** Queue manager and in-place queued prompt editing state. */
    queueManagerOpen = false;
    queueSelected = 0;
    editingQueuedIndex;
    editingQueuedOriginal;
    /** Activity card navigation. */
    selectedCardIndex = 0;
    selectedStepIndex;
    tick;
    paintTimer;
    escapeTimer;
    scrollTimer;
    scrollTarget = 0;
    hasSentFirstMessage = false;
    lastInterrupt = 0;
    cleaned = false;
    /** Agent status strip state. */
    agentStatus;
    done;
    resolveDone;
    constructor(runtime) {
        this.runtime = runtime;
        this.state = {
            session: runtime.session,
            agent: runtime.agent,
            providerId: runtime.providerId,
            model: runtime.model,
        };
        this.hasSentFirstMessage = this.state.session.messages.some((message) => message.role === "user");
        this.done = new Promise((resolve) => {
            this.resolveDone = resolve;
        });
        runtime.broker.handler = (request) => this.ask(request);
    }
    async run() {
        this.restoreSession();
        this.enter();
        try {
            await this.done;
        }
        finally {
            this.cleanup();
        }
    }
    enter() {
        output.write(`${ALT_ON}${PASTE_ON}\u001b[2J\u001b[H${CURSOR_OFF}`);
        input.setRawMode?.(true);
        input.setEncoding("utf8");
        input.resume();
        input.on("data", this.onData);
        output.on("resize", this.onResize);
        process.on("exit", this.restore);
        process.on("SIGTERM", this.onTerminate);
        this.paint();
    }
    /** Hydrate an existing session; the active model lives in the composer now. */
    restoreSession() {
        if (this.state.session.messages.length > 0) {
            this.transcript.info("Resumed session.");
            this.transcript.hydrate(this.state.session);
        }
    }
    restore = () => {
        output.write(`${PASTE_OFF}${CURSOR_ON}${ALT_OFF}`);
    };
    cleanup() {
        if (this.cleaned)
            return;
        this.cleaned = true;
        if (this.tick)
            clearInterval(this.tick);
        if (this.paintTimer)
            clearTimeout(this.paintTimer);
        if (this.escapeTimer)
            clearTimeout(this.escapeTimer);
        if (this.scrollTimer)
            clearTimeout(this.scrollTimer);
        input.off("data", this.onData);
        output.off("resize", this.onResize);
        process.off("exit", this.restore);
        process.off("SIGTERM", this.onTerminate);
        try {
            input.setRawMode?.(false);
        }
        catch {
            // Terminal may already be gone; nothing useful to do.
        }
        input.pause();
        this.restore();
    }
    quit() {
        if (this.approval) {
            this.approval.resolve("no");
            this.approval = undefined;
        }
        if (this.busy)
            this.busy.controller.abort();
        this.resolveDone();
    }
    onTerminate = () => {
        this.cleanup();
        process.exit(130);
    };
    onResize = () => {
        this.painter.reset();
        this.paint();
    };
    onData = (chunk) => {
        const events = this.parser.push(chunk);
        for (const event of events) {
            if (this.approval) {
                this.handleApprovalKey(event);
                continue;
            }
            if (this.modelPickerOpen) {
                this.handleModelPickerKey(event);
                continue;
            }
            if (this.providerPickerOpen) {
                this.handleProviderPickerKey(event);
                continue;
            }
            if (this.queueManagerOpen) {
                this.handleQueueManagerKey(event);
                continue;
            }
            if (this.paletteOpen) {
                this.handlePaletteKey(event);
                continue;
            }
            this.handleKey(event);
        }
        if (this.parser.pendingLength > 0)
            this.scheduleEscapeFlush();
    };
    scheduleEscapeFlush() {
        if (this.escapeTimer)
            clearTimeout(this.escapeTimer);
        this.escapeTimer = setTimeout(() => {
            this.escapeTimer = undefined;
            for (const event of this.parser.flush())
                this.handleKey(event);
        }, 30);
    }
    handleKey(event) {
        if (this.approval) {
            this.handleApprovalKey(event);
            return;
        }
        if (this.modelPickerOpen) {
            this.handleModelPickerKey(event);
            return;
        }
        if (this.providerPickerOpen) {
            this.handleProviderPickerKey(event);
            return;
        }
        if (this.queueManagerOpen) {
            this.handleQueueManagerKey(event);
            return;
        }
        if (this.paletteOpen) {
            this.handlePaletteKey(event);
            return;
        }
        if (event.type === "text") {
            this.applyEdit(event);
            return;
        }
        const name = event.name;
        const ctrl = event.ctrl === true;
        if (ctrl && name === "q") {
            if (this.editingQueuedIndex !== undefined) {
                this.transcript.notice("Save or cancel the queued prompt edit first.");
                this.paint();
                return;
            }
            this.openQueueManager();
            return;
        }
        if (this.editingQueuedIndex !== undefined && name === "escape") {
            this.editor.clear();
            this.editingQueuedIndex = undefined;
            this.transcript.notice("Queued prompt edit canceled.");
            this.paint();
            this.processNextQueued();
            return;
        }
        if (ctrl && name === "c") {
            if (this.editor.text.length > 0) {
                this.copyComposer();
                return;
            }
            this.interrupt();
            return;
        }
        if (ctrl && name === "v") {
            this.pasteClipboard();
            return;
        }
        if (ctrl && name === "d" && this.editor.isEmpty) {
            this.quit();
            return;
        }
        if (ctrl && name === "o") {
            this.expanded = !this.expanded;
            this.paint();
            return;
        }
        if (ctrl && name === "l") {
            this.painter.reset();
            this.paint();
            return;
        }
        if (ctrl && name === "t") {
            const verbose = this.tracker.toggleVerbose();
            if (verbose) this.tracker.expandAll();
            else this.tracker.collapseAll();
            this.transcript.invalidateActivities();
            this.transcript.notice(verbose ? "Verbose mode: all cards expanded" : "Verbose mode: cards collapse after completion");
            this.paint();
            return;
        }
        if (ctrl && name === "m") {
            this.openModelPicker().catch((error) => {
                this.transcript.error(errorMessage(error));
                this.paint();
            });
            return;
        }
        if (name === "pageup") {
            this.scrollBy(this.pageSize());
            return;
        }
        if (name === "pagedown") {
            this.scrollBy(-this.pageSize());
            return;
        }
        if ((name === "up" || name === "down") && this.editor.isEmpty) {
            this.scrollBy(name === "up" ? 1 : -1);
            return;
        }
        if (event.alt && name === "e") {
            // Expand/collapse the most recent activity card. Ctrl+E must still
            // reach the editor as "end of line".
            const card = this.tracker.currentCard ?? this.tracker.lastCard;
            if (card) {
                this.tracker.toggleCard(card.id);
                this.transcript.updateCurrentActivity(card);
                this.paint();
            }
            return;
        }
        if (name === "tab") {
            if (this.busy && this.editingQueuedIndex === undefined)
                this.openQueueManager();
            return;
        }
        if (name === "end" && (ctrl || this.editor.isEmpty)) {
            this.jumpToLatest();
            return;
        }
        this.applyEdit(event);
    }
    applyEdit(event) {
        const result = this.editor.handle(event);
        if (result.type === "changed") {
            this.syncQueuedDraft();
            // Open command palette when "/" is typed at the start.
            if (this.editingQueuedIndex === undefined &&
                !this.paletteOpen &&
                this.editor.text === "/" &&
                this.editor.cursor === 1) {
                this.openPalette();
            }
            this.paint();
            return;
        }
        if (result.type === "submit") {
            if (this.paletteOpen) {
                this.selectPaletteItem();
                return;
            }
            this.submit(result.text).catch((error) => {
                this.transcript.error(errorMessage(error));
                this.paint();
            });
        }
    }
    /** Open the command palette. */
    openPalette() {
        this.paletteOpen = true;
        this.resetScroll();
        this.paletteFilter = "/";
        this.paletteSelected = 0;
        this.editor.setText("/");
        this.paint();
    }
    /** Close the command palette and clear the composer. */
    closePalette() {
        this.paletteOpen = false;
        this.paletteFilter = "";
        this.paletteSelected = 0;
        this.editor.clear();
        this.paint();
    }
    /** Handle keys while the command palette is open. */
    handlePaletteKey(event) {
        if (event.type === "text") {
            // Append typed text to filter and editor.
            this.editor.handle(event);
            this.paletteFilter = this.editor.text;
            this.paletteSelected = 0;
            this.paint();
            return;
        }
        const name = event.name;
        const ctrl = event.ctrl === true;
        if (ctrl && name === "c") {
            this.closePalette();
            return;
        }
        if (name === "escape") {
            this.closePalette();
            return;
        }
        if (name === "enter") {
            this.selectPaletteItem();
            return;
        }
        if (name === "backspace") {
            this.editor.handle(event);
            this.paletteFilter = this.editor.text;
            if (this.paletteFilter === "/") {
                this.paletteSelected = 0;
            }
            if (this.editor.text.length <= 1) {
                this.closePalette();
                return;
            }
            this.paint();
            return;
        }
        if (name === "up") {
            const count = this.filteredCommands().length;
            if (count === 0)
                return;
            this.paletteSelected = (this.paletteSelected - 1 + count) % count;
            this.paint();
            return;
        }
        if (name === "down") {
            const count = this.filteredCommands().length;
            if (count === 0)
                return;
            this.paletteSelected = (this.paletteSelected + 1) % count;
            this.paint();
            return;
        }
        // Let other keys (home, end, arrows, etc.) pass through to the editor.
        this.editor.handle(event);
        this.paletteFilter = this.editor.text;
        this.paletteSelected = 0;
        this.paint();
    }
    /** Commands matching the current palette filter. */
    filteredCommands() {
        const f = this.paletteFilter.slice(1).toLowerCase(); // strip leading "/"
        return COMMANDS.filter((c) => c.name.includes(f) || c.desc.toLowerCase().includes(f));
    }
    /** Execute the currently selected palette item. */
    selectPaletteItem() {
        const cmd = this.filteredCommands()[this.paletteSelected];
        if (!cmd) {
            this.closePalette();
            return;
        }
        this.closePalette();
        // Execute the slash command via the shared handler.
        const text = `/${cmd.name}`;
        const sink = {
            info: (message) => {
                this.transcript.info(message);
            },
            error: (message, hint) => {
                this.transcript.error(message, hint);
            },
        };
        this.submit(text).catch((error) => {
            this.transcript.error(errorMessage(error));
            this.paint();
        });
    }
    /** Fetch available models from the current provider's OpenAI-compatible /models endpoint. */
    async fetchModels() {
        try {
            this.modelPickerModels = await this.runtime.listModels(this.state.providerId);
            this.modelPickerError = undefined;
        }
        catch (error) {
            this.modelPickerModels = [];
            this.modelPickerError = errorMessage(error);
        }
    }
    /** Open the interactive model picker (called by /models command). */
    async showModelPicker() {
        await this.openModelPicker();
    }
    async showProviderPicker() {
        await this.openProviderPicker();
    }
    async openProviderPicker() {
        this.modelPickerOpen = false;
        this.providerPickerOpen = true;
        this.resetScroll();
        this.providerPickerFilter = "";
        this.providerPickerProviders = await this.runtime.listProviders();
        const activeIndex = this.providerPickerProviders.findIndex((provider) => provider.id === this.state.providerId);
        this.providerPickerSelected = Math.max(0, activeIndex);
        this.paint();
    }
    closeProviderPicker() {
        this.providerPickerOpen = false;
        this.providerPickerFilter = "";
        this.providerPickerSelected = 0;
        this.providerPickerProviders = [];
        this.providerAddMode = false;
        this.providerAddInput = "";
        this.providerAddError = "";
        this.providerCredentialMode = false;
        this.providerCredentialProvider = undefined;
        this.providerKeyInput = "";
        this.providerEndpointMode = false;
        this.providerEndpointInput = "";
        this.paint();
    }
    filteredProviders() {
        const filter = this.providerPickerFilter.toLowerCase();
        if (!filter)
            return this.providerPickerProviders;
        return this.providerPickerProviders.filter((provider) => `${provider.id} ${provider.model} ${provider.baseURL ?? ""}`.toLowerCase().includes(filter));
    }
    selectProvider() {
        const provider = this.filteredProviders()[this.providerPickerSelected];
        if (!provider)
            return;
        this.providerCredentialProvider = provider;
        this.providerKeyInput = "";
        this.providerAddError = "";
        if (provider.id === "anyroute" || (provider.id === "openai-compatible" && !provider.baseURL)) {
            this.providerEndpointMode = true;
            this.providerEndpointInput = this.providerEndpointOverrides.get(provider.id) ?? provider.baseURL ?? "";
        }
        else {
            this.providerCredentialMode = true;
        }
        this.paint();
    }
    async connectSelectedProvider() {
        const provider = this.providerCredentialProvider;
        if (!provider)
            return;
        try {
            const rebuilt = await this.runtime.rebuild({
                providerId: provider.id,
                model: provider.model || this.state.model,
                ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
                ...(this.providerKeyInput.trim() ? { apiKey: this.providerKeyInput.trim() } : {}),
            });
            Object.assign(this.state, rebuilt);
            if (provider.baseURL)
                this.providerEndpointOverrides.set(provider.id, provider.baseURL);
            this.state.session.provider = this.state.providerId;
            this.state.session.model = this.state.model;
            this.transcript.info(`Connected to ${this.state.providerId} · ${this.state.model}`);
            this.closeProviderPicker();
        }
        catch (error) {
            this.providerAddError = errorMessage(error);
            this.providerCredentialMode = true;
            this.paint();
        }
    }
    async saveCustomProvider() {
        const [id, model, baseURL, keyEnv] = this.providerAddInput.trim().split(/\s+/);
        if (!id || !model || !baseURL) {
            this.providerAddError = "Enter: id model base-url [key-env]";
            this.paint();
            return;
        }
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
            this.providerAddError = "Provider id may use letters, numbers, '.', '_' and '-'.";
            this.paint();
            return;
        }
        try {
            const parsedURL = new URL(baseURL);
            if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
                throw new TypeError("Provider URLs must use HTTP or HTTPS.");
            }
            await this.runtime.saveProvider(id, {
                model,
                baseURL,
                ...(keyEnv ? { keyEnv } : {}),
            });
            this.providerPickerProviders = await this.runtime.listProviders();
            this.providerPickerFilter = "";
            this.providerPickerSelected = Math.max(0, this.providerPickerProviders.findIndex((provider) => provider.id === id));
            this.providerAddMode = false;
            this.providerAddInput = "";
            this.providerAddError = "";
            this.transcript.info(`Saved provider ${id}. Select it with Enter.`);
            this.paint();
        }
        catch (error) {
            this.providerAddError = error instanceof TypeError
                ? "Enter a valid base URL, including http:// or https://."
                : errorMessage(error);
            this.paint();
        }
    }
    /** Open the model picker. */
    async openModelPicker() {
        this.providerPickerOpen = false;
        this.modelPickerOpen = true;
        this.resetScroll();
        this.modelPickerFilter = "";
        this.modelPickerSelected = 0;
        this.modelPickerModels = [];
        this.modelPickerError = undefined;
        this.modelPickerLoading = true;
        this.paint();
        try {
            await this.fetchModels();
        }
        finally {
            this.modelPickerLoading = false;
            this.paint();
        }
    }
    /** Close the model picker. */
    closeModelPicker() {
        this.modelPickerOpen = false;
        this.modelPickerFilter = "";
        this.modelPickerSelected = 0;
        this.modelPickerModels = [];
        this.modelPickerError = undefined;
        this.paint();
    }
    filteredModels() {
        const f = this.modelPickerFilter.toLowerCase();
        const models = [...new Set([
                this.state.model,
                ...(this.pendingModelSwitch ? [this.pendingModelSwitch] : []),
                ...this.modelPickerModels,
            ])];
        if (!f)
            return models;
        return models.filter((model) => model.toLowerCase().includes(f));
    }
    async selectModel() {
        const models = this.filteredModels();
        const model = models[this.modelPickerSelected] ?? this.modelPickerFilter.trim();
        if (!model) {
            this.closeModelPicker();
            return;
        }
        if (this.busy) {
            this.pendingModelSwitch = model === this.state.model ? undefined : model;
            this.transcript.info(this.pendingModelSwitch
                ? `Model switch queued: ${this.state.providerId}/${this.pendingModelSwitch}. It will apply after the current turn.`
                : "Pending model switch canceled; the current model will remain active.");
            this.closeModelPicker();
            return;
        }
        try {
            const rebuilt = await this.runtime.rebuild({
                providerId: this.runtime.providerId,
                model,
            });
            Object.assign(this.state, rebuilt);
            this.state.session.provider = this.state.providerId;
            this.state.session.model = this.state.model;
            this.transcript.info(`Model: ${this.state.providerId}/${this.state.model}`);
        }
        catch (error) {
            this.transcript.error(errorMessage(error));
        }
        this.closeModelPicker();
        this.paint();
    }
    modelOverlay(height) {
        const models = this.filteredModels();
        const body = [color.dim(`Active: ${this.state.model}`)];
        if (this.pendingModelSwitch) {
            body.push(color.yellow(`After current turn: ${this.pendingModelSwitch}`));
        }
        if (this.modelPickerFilter)
            body.push(`Search: ${this.modelPickerFilter}`);
        let highlight;
        if (this.modelPickerLoading) {
            body.push(color.dim("Loading models…"));
        }
        else if (this.modelPickerError) {
            body.push(color.yellow(this.modelPickerError));
            if (this.state.providerId === "anyroute") {
                body.push(color.dim("Start the AnyRoute gateway (`anyroute`) and reopen /models."));
            }
            body.push(color.dim("Type a model ID and press Enter, or Esc to close."));
        }
        else if (models.length === 0) {
            body.push(color.dim("No model catalog available. Type a model ID and press Enter."));
        }
        else {
            const maxShow = Math.max(1, Math.min(10, height - 10));
            const start = Math.max(0, Math.min(this.modelPickerSelected - Math.floor(maxShow / 2), models.length - maxShow));
            const end = Math.min(models.length, start + maxShow);
            for (let i = start; i < end; i++) {
                const model = models[i];
                if (!model)
                    continue;
                const isSelected = i === this.modelPickerSelected;
                const active = model === this.state.model ? "●" : " ";
                body.push(`${isSelected ? "›" : " "} ${active} ${model}`);
                if (isSelected)
                    highlight = body.length - 1;
            }
        }
        return {
            title: `Models · ${this.state.providerId}`,
            body,
            footer: "↑↓ move · Enter use · Tab switch provider · Esc close",
            ...(highlight !== undefined ? { highlight } : {}),
        };
    }
    providerOverlay(height) {
        const body = [];
        if (this.providerCredentialMode) {
            body.push(color.dim("API key · entered only for this process, never saved"));
            body.push(`${"•".repeat(this.providerKeyInput.length)}▌`);
            if (this.providerAddError)
                body.push(color.yellow(this.providerAddError));
            return {
                title: `Connect · ${this.providerCredentialProvider?.id ?? "provider"}`,
                body,
                footer: "Enter connect · Esc back",
            };
        }
        if (this.providerEndpointMode) {
            const providerId = this.providerCredentialProvider?.id;
            body.push(color.dim(providerId === "anyroute"
                ? "AnyRoute gateway base URL"
                : "OpenAI-compatible provider base URL"));
            body.push(`> ${this.providerEndpointInput}`);
            if (this.providerAddError)
                body.push(color.yellow(this.providerAddError));
            return {
                title: `Connect · ${providerId === "anyroute" ? "AnyRoute endpoint" : "API endpoint"}`,
                body,
                footer: "Enter continue · Ctrl+U replace · Esc back",
            };
        }
        if (this.providerAddMode) {
            body.push(color.dim("Format: id model base-url [key-env]"));
            body.push(`> ${this.providerAddInput}`);
            if (this.providerAddError)
                body.push(color.yellow(this.providerAddError));
            return {
                title: "Add custom provider",
                body,
                footer: "Enter save · Esc cancel",
            };
        }
        body.push(color.dim(`Active: ${this.state.providerId.toUpperCase()}`));
        if (this.providerPickerFilter)
            body.push(`Search: ${this.providerPickerFilter}`);
        const providers = this.filteredProviders();
        let highlight;
        if (providers.length === 0) {
            body.push(color.dim("No providers match this search."));
        }
        else {
            const maxShow = Math.max(1, Math.min(10, height - 8));
            const start = Math.max(0, Math.min(this.providerPickerSelected - Math.floor(maxShow / 2), providers.length - maxShow));
            const end = Math.min(providers.length, start + maxShow);
            for (let i = start; i < end; i++) {
                const provider = providers[i];
                if (!provider)
                    continue;
                const selected = i === this.providerPickerSelected;
                const active = provider.id === this.state.providerId ? "●" : " ";
                body.push(`${selected ? "›" : " "} ${active} ${provider.id.toUpperCase()}`);
                if (selected)
                    highlight = body.length - 1;
            }
        }
        return {
            title: providers.length
                ? `Connect · ${Math.min(this.providerPickerSelected + 1, providers.length)}/${providers.length}`
                : "Connect",
            body,
            footer: "↑↓ move · Enter connect · Shift+A custom · Tab models · Esc close",
            ...(highlight !== undefined ? { highlight } : {}),
        };
    }
    paletteOverlay(height) {
        const cmds = this.filteredCommands();
        const body = [];
        let highlight;
        if (cmds.length === 0) {
            body.push(color.dim("No matching commands."));
        }
        else {
            const maxShow = Math.max(1, Math.min(10, height - 6));
            const start = Math.max(0, Math.min(this.paletteSelected - Math.floor(maxShow / 2), cmds.length - maxShow));
            const end = Math.min(cmds.length, start + maxShow);
            for (let i = start; i < end; i++) {
                const cmd = cmds[i];
                if (!cmd)
                    continue;
                const isSelected = i === this.paletteSelected;
                const args = cmd.args ? ` ${cmd.args}` : "";
                body.push(`${isSelected ? "›" : " "} /${cmd.name}${args}  ·  ${cmd.desc}`);
                if (isSelected)
                    highlight = body.length - 1;
            }
        }
        return {
            title: cmds.length ? `Commands · ${this.paletteSelected + 1}/${cmds.length}` : "Commands",
            body,
            footer: "↑↓ move · Enter run · Esc close",
            ...(highlight !== undefined ? { highlight } : {}),
        };
    }
    queueOverlay(height) {
        const prompts = this.promptQueue.list();
        const body = [];
        let highlight;
        if (prompts.length === 0) {
            body.push(color.dim("Queue is empty. Submit a prompt while the agent is busy to add one."));
        }
        else {
            const maxShow = Math.max(1, Math.min(8, height - 6));
            const start = Math.max(0, Math.min(this.queueSelected - Math.floor(maxShow / 2), prompts.length - maxShow));
            const end = Math.min(prompts.length, start + maxShow);
            for (let index = start; index < end; index++) {
                const prompt = prompts[index];
                if (prompt === undefined)
                    continue;
                const text = `${index + 1}. ${prompt.replace(/\s+/g, " ")}`;
                body.push(index === this.queueSelected ? `› ${text}` : `  ${text}`);
                if (index === this.queueSelected)
                    highlight = body.length - 1;
            }
        }
        return {
            title: `Queue · ${prompts.length} waiting`,
            body,
            footer: "↑↓ select · E edit · X/Del remove · Esc close",
            ...(highlight !== undefined ? { highlight } : {}),
        };
    }
    activeOverlay(height) {
        if (this.queueManagerOpen)
            return this.queueOverlay(height);
        if (this.providerPickerOpen)
            return this.providerOverlay(height);
        if (this.modelPickerOpen)
            return this.modelOverlay(height);
        if (this.paletteOpen)
            return this.paletteOverlay(height);
        return undefined;
    }
    handleProviderPickerKey(event) {
        if (this.providerEndpointMode) {
            if (event.type === "key" && event.ctrl && event.name === "u") {
                this.providerEndpointInput = "";
                this.providerAddError = "";
                this.paint();
                return;
            }
            if (event.type === "text") {
                this.providerEndpointInput += event.text;
                this.providerAddError = "";
                this.paint();
                return;
            }
            if (event.name === "escape") {
                this.providerEndpointMode = false;
                this.providerEndpointInput = "";
                this.providerCredentialProvider = undefined;
                this.paint();
            }
            else if (event.name === "backspace") {
                this.providerEndpointInput = this.providerEndpointInput.slice(0, -1);
                this.paint();
            }
            else if (event.name === "enter") {
                try {
                    const baseURL = this.providerEndpointInput.trim();
                    const parsed = new URL(baseURL);
                    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                        throw new TypeError("Use an http:// or https:// endpoint.");
                    }
                    if (!this.providerCredentialProvider)
                        return;
                    this.providerCredentialProvider = { ...this.providerCredentialProvider, baseURL };
                    this.providerEndpointOverrides.set(this.providerCredentialProvider.id, baseURL);
                    this.providerEndpointMode = false;
                    this.providerCredentialMode = true;
                    this.providerAddError = "";
                    this.paint();
                }
                catch {
                    this.providerAddError = "Enter a valid http:// or https:// URL.";
                    this.paint();
                }
            }
            return;
        }
        if (this.providerCredentialMode) {
            if (event.type === "text") {
                this.providerKeyInput += event.text;
                this.providerAddError = "";
                this.paint();
                return;
            }
            if (event.name === "escape") {
                this.providerCredentialMode = false;
                this.providerCredentialProvider = undefined;
                this.providerKeyInput = "";
                this.providerAddError = "";
                this.paint();
            }
            else if (event.name === "backspace") {
                this.providerKeyInput = this.providerKeyInput.slice(0, -1);
                this.paint();
            }
            else if (event.name === "enter") {
                this.connectSelectedProvider().catch((error) => {
                    this.providerAddError = errorMessage(error);
                    this.paint();
                });
            }
            return;
        }
        if (this.providerAddMode) {
            if (event.type === "text") {
                this.providerAddInput += event.text;
                this.providerAddError = "";
                this.paint();
                return;
            }
            if (event.name === "escape" || (event.ctrl && event.name === "c")) {
                this.providerAddMode = false;
                this.providerAddInput = "";
                this.providerAddError = "";
                this.paint();
            }
            else if (event.name === "backspace") {
                this.providerAddInput = this.providerAddInput.slice(0, -1);
                this.paint();
            }
            else if (event.name === "enter") {
                this.saveCustomProvider().catch((error) => {
                    this.providerAddError = errorMessage(error);
                    this.paint();
                });
            }
            return;
        }
        if (event.type === "text") {
            if (event.text === "A") {
                this.providerAddMode = true;
                this.providerAddInput = "";
                this.providerAddError = "";
            }
            else {
                this.providerPickerFilter += event.text;
                this.providerPickerSelected = 0;
            }
            this.paint();
            return;
        }
        if (event.name === "escape" || (event.ctrl && event.name === "c")) {
            this.closeProviderPicker();
        }
        else if (event.name === "tab" || event.name === "right") {
            this.openModelPicker().catch((error) => {
                this.transcript.error(errorMessage(error));
                this.paint();
            });
        }
        else if (event.name === "backspace") {
            this.providerPickerFilter = this.providerPickerFilter.slice(0, -1);
            this.providerPickerSelected = 0;
            this.paint();
        }
        else if (event.name === "up" || event.name === "down") {
            const providers = this.filteredProviders();
            if (providers.length === 0)
                return;
            const delta = event.name === "up" ? -1 : 1;
            this.providerPickerSelected = (this.providerPickerSelected + delta + providers.length) % providers.length;
            this.paint();
        }
        else if (event.name === "enter") {
            this.selectProvider();
        }
    }
    handleModelPickerKey(event) {
        if (event.type === "key" && (event.name === "tab" || event.name === "left")) {
            this.openProviderPicker().catch((error) => {
                this.transcript.error(errorMessage(error));
                this.paint();
            });
            return;
        }
        if (event.type === "text") {
            this.modelPickerFilter += event.text;
            this.modelPickerSelected = 0;
            this.paint();
            return;
        }
        if (event.type === "key") {
            if (event.name === "escape" || (event.ctrl && event.name === "c")) {
                this.closeModelPicker();
                return;
            }
            if (event.name === "backspace") {
                this.modelPickerFilter = this.modelPickerFilter.slice(0, -1);
                this.modelPickerSelected = 0;
                this.paint();
                return;
            }
            if (event.name === "up") {
                const models = this.filteredModels();
                if (models.length === 0)
                    return;
                this.modelPickerSelected = (this.modelPickerSelected - 1 + models.length) % models.length;
                this.paint();
                return;
            }
            if (event.name === "down") {
                const models = this.filteredModels();
                if (models.length === 0)
                    return;
                this.modelPickerSelected = (this.modelPickerSelected + 1) % models.length;
                this.paint();
                return;
            }
            if (event.name === "enter") {
                this.selectModel().catch((error) => {
                    this.transcript.error(errorMessage(error));
                    this.paint();
                });
                return;
            }
        }
    }
    handleApprovalKey(event) {
        const answerFor = (value) => {
            const lower = value.trim().toLowerCase();
            if (lower.startsWith("y"))
                return "yes";
            if (lower.startsWith("a"))
                return "always";
            if (lower.startsWith("n"))
                return "no";
            return undefined;
        };
        if (event.type === "text") {
            const answer = answerFor(event.text);
            if (answer)
                this.answer(answer);
            return;
        }
        if (event.name === "escape" || event.name === "enter" || (event.ctrl && event.name === "c")) {
            this.answer("no");
            return;
        }
        const answer = answerFor(event.name);
        if (answer)
            this.answer(answer);
    }
    answer(value) {
        const pending = this.approval;
        if (!pending)
            return;
        this.approval = undefined;
        this.tracker.clearPermission();
        const card = this.tracker.currentCard;
        if (card)
            this.transcript.updateCurrentActivity(card);
        pending.resolve(value);
        this.paint();
    }
    ask(request) {
        return new Promise((resolve) => {
            this.approval = { request, resolve };
            const toolCall = {
                id: `call-${Date.now()}`,
                name: request.tool,
                arguments: JSON.stringify({ command: request.detail ?? "" }),
            };
            const approval = shellApprovalFor(toolCall, { command: request.detail ?? "" });
            this.tracker.setShellApproval(approval);
            this.transcript.updateCurrentActivity(this.tracker.currentCard);
            this.paint();
        });
    }
    interrupt() {
        if (this.busy) {
            this.busy.controller.abort();
            this.busy.label = "stopping";
            this.paint();
            return;
        }
        if (this.editor.clear()) {
            this.paint();
            return;
        }
        const now = Date.now();
        if (now - this.lastInterrupt < CTRL_C_WINDOW_MS) {
            this.quit();
            return;
        }
        this.lastInterrupt = now;
        this.transcript.notice("Press ctrl+c again to exit.");
        this.paint();
    }
    copyComposer() {
        writeClipboard(this.editor.text).then(() => {
            this.transcript.notice("Composer text copied to clipboard.");
            this.paint();
        }).catch((error) => {
            this.transcript.error(`Clipboard copy failed: ${errorMessage(error)}`);
            this.paint();
        });
    }
    pasteClipboard() {
        readClipboard().then((text) => {
            if (text.length > 0)
                this.applyEdit({ type: "text", text });
        }).catch((error) => {
            this.transcript.error(`Clipboard paste failed: ${errorMessage(error)}`);
            this.paint();
        });
    }
    openQueueManager() {
        this.queueManagerOpen = true;
        this.queueSelected = Math.min(this.queueSelected, Math.max(0, this.promptQueue.length - 1));
        this.resetScroll();
        this.paint();
    }
    closeQueueManager() {
        this.queueManagerOpen = false;
        this.paint();
        this.processNextQueued();
    }
    handleQueueManagerKey(event) {
        if (this.editingQueuedIndex !== undefined) {
            if (event.type === "text") {
                this.applyEdit(event);
                return;
            }
            if (event.ctrl && event.name === "c") {
                if (this.editor.text.length > 0)
                    this.copyComposer();
                else
                    this.interrupt();
                return;
            }
            if (event.ctrl && event.name === "v") {
                this.pasteClipboard();
                return;
            }
            if (event.name === "escape") {
                this.finishQueuedEdit(false);
                return;
            }
            if (event.name === "enter" && !event.ctrl && !event.shift && !event.alt) {
                this.finishQueuedEdit(true);
                return;
            }
            this.applyEdit(event);
            return;
        }
        if (event.type === "text") {
            if (event.text.toLowerCase() === "e") {
                const prompt = this.promptQueue.at(this.queueSelected);
                if (prompt === undefined)
                    return;
                this.editingQueuedIndex = this.queueSelected;
                this.editingQueuedOriginal = prompt;
                this.editor.setText(prompt);
                this.paint();
                return;
            }
            if (event.text.toLowerCase() === "x") {
                this.removeQueuedPrompt();
            }
            return;
        }
        if (event.ctrl && event.name === "c") {
            this.queueManagerOpen = false;
            this.interrupt();
        }
        else if (event.name === "escape" || (event.ctrl && event.name === "q")) {
            this.closeQueueManager();
        }
        else if (event.name === "up" || event.name === "down") {
            if (this.promptQueue.length === 0)
                return;
            const direction = event.name === "up" ? -1 : 1;
            this.queueSelected = (this.queueSelected + direction + this.promptQueue.length) % this.promptQueue.length;
            this.paint();
        }
        else if (event.name === "delete" || event.name === "backspace") {
            this.removeQueuedPrompt();
        }
    }
    syncQueuedDraft() {
        if (this.editingQueuedIndex === undefined)
            return;
        this.promptQueue.setDraft(this.editingQueuedIndex, this.editor.text);
    }
    finishQueuedEdit(save) {
        const index = this.editingQueuedIndex;
        if (index === undefined)
            return;
        if (save && !this.promptQueue.update(index, this.editor.text)) {
            this.transcript.error("A queued prompt cannot be empty. Type a message or press Esc to restore it.");
            this.paint();
            return;
        }
        if (!save && this.editingQueuedOriginal !== undefined) {
            this.promptQueue.setDraft(index, this.editingQueuedOriginal);
        }
        this.editingQueuedIndex = undefined;
        this.editingQueuedOriginal = undefined;
        this.editor.clear();
        this.transcript.info(save ? "Queued prompt updated." : "Queued prompt edit canceled.");
        this.paint();
        this.processNextQueued();
    }
    removeQueuedPrompt() {
        if (this.promptQueue.remove(this.queueSelected) === undefined)
            return;
        this.queueSelected = Math.min(this.queueSelected, Math.max(0, this.promptQueue.length - 1));
        if (this.promptQueue.length === 0)
            this.queueManagerOpen = false;
        this.paint();
        this.processNextQueued();
    }
    processNextQueued() {
        if (this.busy || this.cleaned || this.editingQueuedIndex !== undefined || this.queueManagerOpen)
            return;
        const prompt = this.promptQueue.takeNext();
        if (prompt === undefined)
            return;
        this.queueSelected = Math.min(this.queueSelected, Math.max(0, this.promptQueue.length - 1));
        this.paint();
        this.startTurn(prompt).catch((error) => {
            this.transcript.error(errorMessage(error));
            this.paint();
        });
    }
    async submit(text) {
        this.resetScroll();
        if (this.editingQueuedIndex !== undefined) {
            if (!this.promptQueue.update(this.editingQueuedIndex, text)) {
                this.transcript.error("Queued prompts cannot be empty.");
                this.paint();
                return;
            }
            this.editingQueuedIndex = undefined;
            this.editingQueuedOriginal = undefined;
            this.transcript.info("Queued prompt updated in place.");
            this.paint();
            this.processNextQueued();
            return;
        }
        if (text.startsWith("/")) {
            const before = this.state.session.id;
            const sink = {
                info: (message) => {
                    this.transcript.info(message);
                },
                error: (message, hint) => {
                    this.transcript.error(message, hint);
                },
            };
            const exit = await handleSlashCommand(text, this.runtime, this.state, sink);
            if (exit) {
                this.quit();
                return;
            }
            if (this.state.session.id !== before) {
                this.transcript.clear();
                this.changedFiles.clear();
                if (this.state.session.messages.length > 0)
                    this.transcript.hydrate(this.state.session);
                this.hasSentFirstMessage = this.state.session.messages.some((message) => message.role === "user");
            }
            this.paint();
            return;
        }
        if (this.busy) {
            this.promptQueue.enqueue(text);
            this.transcript.notice(`Queued: ${text}`);
            this.paint();
            return;
        }
        await this.startTurn(text);
    }
    async startTurn(text) {
        if (this.busy) {
            this.promptQueue.enqueue(text);
            this.transcript.notice(`Queued: ${text}`);
            this.paint();
            return;
        }
        this.finishActivity();
        this.changedFiles.clear();
        // Title the live coding box with the user's request so the work is
        // framed by the task, not by whichever tool happened to run first.
        this.tracker.startCard(text.trim());
        this.transcript.pushUser(text);
        this.hasSentFirstMessage = true;
        this.resetScroll();
        const controller = new AbortController();
        this.busy = { controller, label: "thinking", startedAt: Date.now() };
        this.tick = setInterval(() => this.paint(), TICK_MS);
        this.paint();
        const minBusyMs = 800;
        const turnStarted = Date.now();
        try {
            for await (const event of this.state.agent.run(text, { signal: controller.signal })) {
                this.onEvent(event);
            }
        }
        catch (error) {
            if (!controller.signal.aborted)
                this.transcript.error(errorMessage(error));
        }
        finally {
            // Keep the working status visible briefly so short turns don't flash.
            const elapsed = Date.now() - turnStarted;
            if (elapsed < minBusyMs) {
                await new Promise((resolve) => setTimeout(resolve, minBusyMs - elapsed));
            }
            if (this.tick) {
                clearInterval(this.tick);
                this.tick = undefined;
            }
            this.finishActivity();
            await this.applyPendingModelSwitch();
            this.busy = undefined;
            await this.state.session.save().catch(() => undefined);
            this.paint();
            this.processNextQueued();
        }
    }
    async applyPendingModelSwitch() {
        while (this.pendingModelSwitch) {
            const model = this.pendingModelSwitch;
            this.pendingModelSwitch = undefined;
            try {
                const rebuilt = await this.runtime.rebuild({
                    providerId: this.state.providerId,
                    model,
                });
                Object.assign(this.state, rebuilt);
                this.state.session.provider = this.state.providerId;
                this.state.session.model = this.state.model;
                this.transcript.info(`Model switched to ${this.state.providerId}/${this.state.model}.`);
            }
            catch (error) {
                this.transcript.error(`Model switch failed: ${errorMessage(error)}`);
            }
        }
    }
    finishActivity() {
        const card = this.tracker.finishCurrentCard();
        if (card && (card.steps.length > 0 || (card.changes?.length ?? 0) > 0)) {
            this.transcript.updateCurrentActivity(card);
        }
    }
    onEvent(event) {
        switch (event.type) {
            case "turn_start":
                if (this.busy)
                    this.busy.label = event.step > 1 ? `step ${event.step}` : "thinking";
                this.schedulePaint();
                break;
            case "text":
                this.finishActivity();
                this.transcript.appendAssistant(event.text);
                this.schedulePaint();
                break;
            case "reasoning":
                break;
            case "tool_start": {
                const step = this.tracker.addStep(event.call, event.input);
                this.transcript.updateCurrentActivity(this.tracker.currentCard);
                this.paint();
                break;
            }
            case "tool_end": {
                const completed = this.tracker.completeStepByCall(event.call.id, event.content, event.isError, event.durationMs);
                if (completed) {
                    this.transcript.updateCurrentActivity(completed.card);
                } else {
                    // Some failures (unknown tool, malformed arguments, loop
                    // guard) arrive without a matching tool_start. Record them
                    // so the conversation still shows what happened.
                    const step = this.tracker.addStep(event.call, {});
                    this.tracker.completeStep(step.id, event.content, event.isError, event.durationMs);
                    const card = this.tracker.currentCard;
                    if (card) this.transcript.updateCurrentActivity(card);
                }
                this.paint();
                break;
            }
            case "file_change": {
                this.changedFiles.add(event.change.path);
                const card = this.tracker.addChange(event.change);
                this.transcript.updateCurrentActivity(card);
                this.paint();
                break;
            }
            case "compaction":
                this.transcript.notice(`Trimmed ${event.removedMessages} old messages to stay inside the context window.`);
                this.paint();
                break;
            case "notice":
                this.transcript.notice(event.message);
                this.paint();
                break;
            case "error":
                this.transcript.error(event.message, event.hint);
                this.paint();
                break;
            case "usage":
                this.transcript.setUsage(event.usage);
                this.schedulePaint();
                break;
            case "done":
                this.finishActivity();
                if (event.aborted) {
                    this.transcript.notice("Interrupted.");
                }
                this.paint();
                break;
        }
    }
    schedulePaint() {
        if (this.paintTimer)
            return;
        this.paintTimer = setTimeout(() => {
            this.paintTimer = undefined;
            this.paint();
        }, 33);
    }
    pageSize() {
        return Math.max(1, (this.frame?.bodyHeight ?? 10) - 2);
    }
    scrollBy(delta) {
        const transcriptLines = this.transcript.render(Math.max(10, output.columns - 2), this.expanded, Date.now()).length;
        const maxScroll = Math.max(0, transcriptLines - 1);
        const currentTarget = this.scrollTimer ? this.scrollTarget : this.scroll;
        this.scrollTarget = clamp(currentTarget + delta, 0, maxScroll);
        if (this.scrollTimer)
            return;
        const animate = () => {
            const difference = this.scrollTarget - this.scroll;
            if (difference === 0) {
                this.scrollTimer = undefined;
                return;
            }
            this.scroll += Math.sign(difference);
            this.paint();
            this.scrollTimer = setTimeout(animate, 18);
        };
        animate();
    }
    resetScroll() {
        if (this.scrollTimer)
            clearTimeout(this.scrollTimer);
        this.scrollTimer = undefined;
        this.scroll = 0;
        this.scrollTarget = 0;
    }
    /** Snap the transcript to the newest line. */
    jumpToLatest() {
        if (this.scroll === 0 && this.scrollTarget === 0)
            return;
        this.resetScroll();
        this.paint();
    }
    compose(width, height, lines) {
        const overlay = this.activeOverlay(height);
        return composeFrame({
            width,
            height,
            header: "",
            showHeader: false,
            transcript: lines,
            ...(overlay ? { overlay } : {}),
            queuedPrompts: this.promptQueue.list(),
            scroll: this.scroll,
            composer: { text: this.editor.text, cursor: this.editor.cursor },
            showBrand: !this.hasSentFirstMessage &&
                this.transcript.isEmpty &&
                !overlay,
            ...(this.approval
                ? {
                    approval: {
                        title: this.approval.request.title,
                        ...(this.approval.request.detail ? { detail: this.approval.request.detail } : {}),
                    },
                }
                : {}),
            usage: this.state.session.usage,
            model: {
                provider: this.state.providerId,
                model: this.state.model,
                autoApprove: this.runtime.broker.autoApprove,
            },
            agentName: "Cavehound",
            agentMode: this.busy ? "running" : "idle",
            agentStatus: this.buildAgentStatus(width, height),
        });
    }
    /** Build the agent status strip input from current Tui state. */
    buildAgentStatus(width, height) {
        if (this.busy) {
            const elapsed = (Date.now() - this.busy.startedAt) / 1000;
            const pulse = nodeColorAt(elapsed * 1000);
            const showGlyph = height >= 10 && width >= 40;
            return {
                status: "working",
                ...(showGlyph
                    ? { glyph: { width: INFINITY_ICON_WIDTH, lines: renderInfinityIcon(elapsed * 1000) } }
                    : { frame: color.bold(rgb(pulse.r, pulse.g, pulse.b)("∞")) }),
                currentIntent: this.promptQueue.length > 0
                    ? `${this.busy.label} · ${this.promptQueue.length} queued${this.pendingModelSwitch ? ` · next ${this.pendingModelSwitch}` : ""}`
                    : this.pendingModelSwitch
                        ? `${this.busy.label} · next ${this.pendingModelSwitch}`
                        : this.busy.label,
                currentStep: undefined,
                totalSteps: undefined,
                durationMs: elapsed * 1000,
                changedFiles: this.changedFiles.size,
                relevantShortcuts: "Tab queue · Ctrl+Q manage",
            };
        }
        if (this.approval) {
            return {
                status: "awaiting_approval",
                currentIntent: this.approval.request.tool,
                currentStep: undefined,
                totalSteps: undefined,
                durationMs: undefined,
                changedFiles: this.changedFiles.size,
                relevantShortcuts: "y run · a always · n cancel",
            };
        }
        return undefined;
    }
    paint() {
        if (this.cleaned)
            return;
        const width = clamp(output.columns ?? 80, 20, 400);
        const height = Math.max(6, output.rows ?? 24);
        const lines = this.transcript.render(Math.max(10, width - 2), this.expanded, Date.now());
        let frame = this.compose(width, height, lines);
        // Preserve the user's scroll position; only adjust if we've gone past the
        // new bottom (e.g. fresh turn) or past the new top. Do not clamp to 0
        // arbitrarily – that makes the transcript feel "stuck" at the bottom.
        const newMax = Math.max(0, lines.length - frame.bodyHeight);
        if (this.scroll > newMax) {
            // user scrolled up; snap to the new max but don't force to 0
            this.scroll = newMax;
            frame = this.compose(width, height, lines);
        }
        else if (this.scroll < 0) {
            // safeguard – never let scroll go negative
            this.scroll = 0;
        }
        this.frame = frame;
        this.painter.paint(frame);
    }
}
export async function runTui(runtime) {
    const tui = new Tui(runtime);
    await tui.run();
}
