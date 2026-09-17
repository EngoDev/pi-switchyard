import {
  DynamicBorder,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  type Focusable,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";

export interface PickerOptions {
  searchable?: boolean;
  maxVisible?: number;
  preselect?: string;
  description?: string;
}

export function filterPickerItems(items: readonly SelectItem[], query: string): SelectItem[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];
  return fuzzyFilter([...items], trimmed, (item) => `${item.label} ${item.description ?? ""}`);
}

class BoundedPicker extends Container implements Focusable {
  private readonly allItems: SelectItem[];
  private readonly maxVisible: number;
  private readonly searchable: boolean;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly tui: TUI;
  private readonly onSelectValue: (value: string) => void;
  private readonly onCancelPicker: () => void;
  private readonly searchInput?: Input;
  private list: SelectList;
  private listChildIndex: number;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.searchInput) this.searchInput.focused = value;
  }

  constructor(
    title: string,
    items: readonly SelectItem[],
    options: PickerOptions,
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.allItems = [...items];
    this.maxVisible = Math.max(1, options.maxVisible ?? 10);
    this.searchable = options.searchable ?? false;
    this.theme = theme;
    this.keybindings = keybindings;
    this.tui = tui;
    this.onSelectValue = onSelect;
    this.onCancelPicker = onCancel;

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    if (options.description) {
      this.addChild(new Text(theme.fg("muted", options.description), 1, 0));
    }
    if (this.searchable) {
      this.addChild(new Spacer(1));
      this.searchInput = new Input();
      this.searchInput.onSubmit = () => this.list.handleInput("\r");
      this.addChild(this.searchInput);
    }
    this.addChild(new Spacer(1));
    this.list = this.buildList(this.allItems, options.preselect);
    this.listChildIndex = this.children.length;
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new Text(
      theme.fg(
        "dim",
        this.searchable
          ? "Type to filter · ↑↓ navigate · enter select · esc cancel"
          : "↑↓ navigate · enter select · esc cancel",
      ),
      1,
      0,
    ));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  }

  private buildList(items: SelectItem[], preselect?: string): SelectList {
    const list = new SelectList(items, Math.min(this.maxVisible, Math.max(1, items.length)), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    if (preselect) {
      const index = items.findIndex((item) => item.value === preselect);
      if (index >= 0) list.setSelectedIndex(index);
    }
    list.onSelect = (item) => this.onSelectValue(item.value);
    list.onCancel = this.onCancelPicker;
    return list;
  }

  private applyFilter(): void {
    const filtered = filterPickerItems(this.allItems, this.searchInput?.getValue() ?? "");
    this.list = this.buildList(filtered);
    this.children[this.listChildIndex] = this.list;
  }

  handleInput(data: string): void {
    if (!this.searchable || !this.searchInput) {
      this.list.handleInput(data);
      this.tui.requestRender();
      return;
    }

    const isListKey =
      this.keybindings.matches(data, "tui.select.up")
      || this.keybindings.matches(data, "tui.select.down")
      || this.keybindings.matches(data, "tui.select.confirm")
      || this.keybindings.matches(data, "tui.select.cancel");
    if (isListKey) this.list.handleInput(data);
    else {
      this.searchInput.handleInput(data);
      this.applyFilter();
    }
    this.tui.requestRender();
  }
}

export async function showPicker(
  ctx: ExtensionCommandContext,
  title: string,
  items: readonly SelectItem[],
  options: PickerOptions = {},
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`${title} requires interactive mode`, "error");
    return undefined;
  }
  const result = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    new BoundedPicker(title, items, options, tui, theme, keybindings, done, () => done(undefined)),
  );
  return result;
}
