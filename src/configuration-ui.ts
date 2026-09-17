import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

import { writeConfigPatch, type ConfigScope } from "./config.js";
import { showPicker } from "./picker.js";
import {
  TIER_NAMES,
  type RouterConfig,
  type ThinkingSelection,
  type TierName,
} from "./types.js";

const STANDARD_THINKING = ["off", "minimal", "low", "medium", "high"] as const;
const EXTENDED_THINKING = ["xhigh", "max"] as const;
export const MODEL_PICKER_MAX_VISIBLE = 10;

export function getThinkingSelections(model: Model<any>): ThinkingSelection[] {
  if (!model.reasoning) return ["default", "off"];
  const selections: ThinkingSelection[] = ["default"];
  for (const level of STANDARD_THINKING) {
    if (model.thinkingLevelMap?.[level] !== null) selections.push(level);
  }
  for (const level of EXTENDED_THINKING) {
    if (typeof model.thinkingLevelMap?.[level] === "string") selections.push(level);
  }
  return selections;
}

function availableModels(ctx: ExtensionCommandContext): Model<any>[] {
  const source = ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((item) => item.model)
    : ctx.modelRegistry.getAvailable();
  const unique = new Map<string, Model<any>>();
  for (const model of source) unique.set(`${model.provider}/${model.id}`, model);
  return [...unique.values()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
}

export function buildCategoryItems(config: RouterConfig): SelectItem[] {
  const tierItems: SelectItem[] = TIER_NAMES.map((tier) => {
    const current = config.tiers[tier];
    return {
      value: `tier:${tier}`,
      label: tier,
      description: current
        ? `${current.provider}/${current.modelId} · thinking:${current.thinking}`
        : "not configured",
    };
  });
  return [
    ...tierItems,
    {
      value: "debug",
      label: "debug",
      description: String(config.debug),
    },
    {
      value: "enabled",
      label: "router enabled",
      description: String(config.enabled),
    },
    {
      value: "show",
      label: "show configuration",
      description: "Display all current settings",
    },
  ];
}

function modelItems(models: readonly Model<any>[], current?: { provider: string; modelId: string }): SelectItem[] {
  return models.map((model) => {
    const isCurrent = current?.provider === model.provider && current.modelId === model.id;
    const name = model.name && model.name !== model.id ? ` · ${model.name}` : "";
    return {
      value: `${model.provider}/${model.id}`,
      label: model.id,
      description: `${model.provider}${name}${isCurrent ? " · current" : ""}`,
    };
  });
}

function formatConfig(config: RouterConfig): string {
  const lines = [`enabled: ${config.enabled}`, `debug: ${config.debug}`];
  for (const tier of TIER_NAMES) {
    const selected = config.tiers[tier];
    lines.push(
      selected
        ? `${tier}: ${selected.provider}/${selected.modelId} (${selected.thinking})`
        : `${tier}: not configured`,
    );
  }
  return lines.join("\n");
}

export interface ConfigurationHooks {
  getConfig(): RouterConfig;
  reloadConfig(ctx: ExtensionCommandContext): void;
  onDebugChanged(ctx: ExtensionCommandContext): void;
}

async function chooseScope(ctx: ExtensionCommandContext, title: string): Promise<ConfigScope | undefined> {
  const scope = await showPicker(ctx, title, [
    { value: "global", label: "global", description: "Use across Pi projects" },
    { value: "project", label: "project", description: "Override only in this trusted project" },
  ], { maxVisible: 4 });
  if (!scope) return undefined;
  if (scope === "project" && !ctx.isProjectTrusted()) {
    ctx.ui.notify("Project configuration requires a trusted project", "error");
    return undefined;
  }
  return scope as ConfigScope;
}

function finishConfigChange(ctx: ExtensionCommandContext, hooks: ConfigurationHooks): void {
  hooks.reloadConfig(ctx);
  hooks.onDebugChanged(ctx);
}

async function editTier(
  ctx: ExtensionCommandContext,
  hooks: ConfigurationHooks,
  tier: TierName,
): Promise<void> {
  const models = availableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify("No authenticated Pi models are available", "error");
    return;
  }

  const current = hooks.getConfig().tiers[tier];
  const selectedRef = await showPicker(
    ctx,
    `${tier}: choose model`,
    modelItems(models, current),
    {
      searchable: true,
      maxVisible: MODEL_PICKER_MAX_VISIBLE,
      ...(current ? { preselect: `${current.provider}/${current.modelId}` } : {}),
      description: "Type any part of the provider, model ID, or model name to filter.",
    },
  );
  if (!selectedRef) return;
  const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === selectedRef);
  if (!model) return;

  const thinking = await showPicker(
    ctx,
    `${tier}: choose thinking`,
    getThinkingSelections(model).map((value) => ({
      value,
      label: value,
      ...(value === "default" ? { description: "Use Pi's default for this model" } : {}),
    })),
    {
      maxVisible: 9,
      ...(current?.thinking ? { preselect: current.thinking } : {}),
      description: `${model.provider}/${model.id}`,
    },
  ) as ThinkingSelection | undefined;
  if (!thinking) return;

  const scope = await chooseScope(ctx, `Save ${tier} configuration`);
  if (!scope) return;
  const path = writeConfigPatch(ctx.cwd, scope, {
    tiers: {
      [tier]: { provider: model.provider, modelId: model.id, thinking },
    },
  });
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(
    `${tier} → ${model.provider}/${model.id} (${thinking}) · ${path}`,
    "info",
  );
}

async function editDebug(ctx: ExtensionCommandContext, hooks: ConfigurationHooks): Promise<void> {
  const selected = await showPicker(ctx, "Debug routing indication", [
    { value: "false", label: "false", description: "Hide route decisions" },
    { value: "true", label: "true", description: "Show thread, model, thinking, and confidence" },
  ], { maxVisible: 4, preselect: String(hooks.getConfig().debug) });
  if (!selected) return;
  const scope = await chooseScope(ctx, "Save debug setting");
  if (!scope) return;
  const path = writeConfigPatch(ctx.cwd, scope, { debug: selected === "true" });
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(`Switchyard debug ${hooks.getConfig().debug ? "enabled" : "disabled"} · ${path}`, "info");
}

async function editEnabled(ctx: ExtensionCommandContext, hooks: ConfigurationHooks): Promise<void> {
  const selected = await showPicker(ctx, "Enable Switchyard", [
    { value: "true", label: "enabled" },
    { value: "false", label: "disabled" },
  ], { maxVisible: 4, preselect: String(hooks.getConfig().enabled) });
  if (!selected) return;
  await saveEnabled(ctx, hooks, selected === "true");
}

async function saveEnabled(
  ctx: ExtensionCommandContext,
  hooks: ConfigurationHooks,
  enabled: boolean,
): Promise<void> {
  const scope = await chooseScope(ctx, "Save enabled setting");
  if (!scope) return;
  const path = writeConfigPatch(ctx.cwd, scope, { enabled });
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(`Switchyard ${hooks.getConfig().enabled ? "enabled" : "disabled"} · ${path}`, "info");
}

export async function runCategoryMenuLoop(
  select: () => Promise<string | undefined>,
  handle: (selection: string) => Promise<void>,
): Promise<void> {
  while (true) {
    const selected = await select();
    if (!selected) return;
    await handle(selected);
  }
}

async function showCategoryMenu(ctx: ExtensionCommandContext, hooks: ConfigurationHooks): Promise<void> {
  await runCategoryMenuLoop(
    () => showPicker(
      ctx,
      "Choose Switchyard category to change",
      buildCategoryItems(hooks.getConfig()),
      { maxVisible: 9 },
    ),
    async (selected) => {
      if (selected.startsWith("tier:")) {
        await editTier(ctx, hooks, selected.slice("tier:".length) as TierName);
      } else if (selected === "debug") {
        await editDebug(ctx, hooks);
      } else if (selected === "enabled") {
        await editEnabled(ctx, hooks);
      } else if (selected === "show") {
        ctx.ui.notify(formatConfig(hooks.getConfig()), "info");
      }
    },
  );
}

export function registerConfigurationCommand(pi: ExtensionAPI, hooks: ConfigurationHooks): void {
  pi.registerCommand("switchyard", {
    description: "Configure and inspect the Switchyard session/model router",
    handler: async (args, ctx) => {
      const direct = args.trim().toLowerCase();
      if ((TIER_NAMES as readonly string[]).includes(direct)) {
        await editTier(ctx, hooks, direct as TierName);
      } else if (!direct || direct === "configure") {
        await showCategoryMenu(ctx, hooks);
      } else if (direct === "debug") {
        await editDebug(ctx, hooks);
      } else if (direct === "on" || direct === "off") {
        await saveEnabled(ctx, hooks, direct === "on");
      } else if (direct === "show") {
        ctx.ui.notify(formatConfig(hooks.getConfig()), "info");
      } else {
        ctx.ui.notify("Usage: /switchyard [genius|smart|handy|cheap|debug|on|off|show]", "error");
      }
    },
  });
}
