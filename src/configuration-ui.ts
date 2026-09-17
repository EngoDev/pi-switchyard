import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { writeConfigPatch, type ConfigScope } from "./config.js";
import {
  TIER_NAMES,
  type RouterConfig,
  type ThinkingSelection,
  type TierConfig,
  type TierName,
} from "./types.js";

const STANDARD_THINKING = ["off", "minimal", "low", "medium", "high"] as const;
const EXTENDED_THINKING = ["xhigh", "max"] as const;

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

function modelLabel(model: Model<any>): string {
  const id = `${model.provider}/${model.id}`;
  return model.name && model.name !== model.id ? `${id} — ${model.name}` : id;
}

async function chooseModel(
  ctx: ExtensionCommandContext,
  tier: TierName,
  models: readonly Model<any>[],
): Promise<Model<any> | undefined> {
  const byLabel = new Map(models.map((model) => [modelLabel(model), model]));
  const selected = await ctx.ui.select(`${tier}: choose model`, [...byLabel.keys()]);
  return selected ? byLabel.get(selected) : undefined;
}

async function chooseThinking(
  ctx: ExtensionCommandContext,
  tier: TierName,
  model: Model<any>,
): Promise<ThinkingSelection | undefined> {
  const selected = await ctx.ui.select(
    `${tier}: thinking for ${model.provider}/${model.id}`,
    getThinkingSelections(model),
  );
  return selected as ThinkingSelection | undefined;
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
  const scope = await ctx.ui.select(title, ["global", "project"]);
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

async function saveDebugToggle(ctx: ExtensionCommandContext, hooks: ConfigurationHooks): Promise<void> {
  const enabled = !hooks.getConfig().debug;
  const scope = await chooseScope(ctx, "Save debug setting");
  if (!scope) return;
  const path = writeConfigPatch(ctx.cwd, scope, { debug: enabled });
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(`Jev router debug ${hooks.getConfig().debug ? "enabled" : "disabled"} (${path})`, "info");
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
  ctx.ui.notify(`Jev router ${hooks.getConfig().enabled ? "enabled" : "disabled"} (${path})`, "info");
}

async function runConfigurationWizard(
  ctx: ExtensionCommandContext,
  hooks: ConfigurationHooks,
): Promise<void> {
  const scope = await chooseScope(ctx, "Save Jev router configuration");
  if (!scope) return;

  const models = availableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify("No authenticated Pi models are available", "error");
    return;
  }

  const tiers: Partial<Record<TierName, TierConfig>> = {};
  for (const tier of TIER_NAMES) {
    const model = await chooseModel(ctx, tier, models);
    if (!model) {
      ctx.ui.notify("Configuration cancelled", "info");
      return;
    }
    const thinking = await chooseThinking(ctx, tier, model);
    if (!thinking) {
      ctx.ui.notify("Configuration cancelled", "info");
      return;
    }
    tiers[tier] = { provider: model.provider, modelId: model.id, thinking };
  }

  const debugSelection = await ctx.ui.select("Show routing debug status?", ["false", "true"]);
  if (!debugSelection) {
    ctx.ui.notify("Configuration cancelled", "info");
    return;
  }

  const path = writeConfigPatch(ctx.cwd, scope, {
    enabled: true,
    debug: debugSelection === "true",
    tiers,
  });
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(`Saved Jev router configuration to ${path}`, "info");
}

export function registerConfigurationCommand(pi: ExtensionAPI, hooks: ConfigurationHooks): void {
  pi.registerCommand("jev-router", {
    description: "Configure and inspect the Jev session/model router",
    handler: async (args, ctx) => {
      const direct = args.trim().toLowerCase();
      if (direct === "configure") return runConfigurationWizard(ctx, hooks);
      if (direct === "debug") return saveDebugToggle(ctx, hooks);
      if (direct === "on" || direct === "off") return saveEnabled(ctx, hooks, direct === "on");
      if (direct === "show") {
        ctx.ui.notify(formatConfig(hooks.getConfig()), "info");
        return;
      }

      const action = await ctx.ui.select("Jev router", [
        "configure tiers",
        "toggle debug",
        hooks.getConfig().enabled ? "disable router" : "enable router",
        "show configuration",
      ]);
      if (action === "configure tiers") await runConfigurationWizard(ctx, hooks);
      else if (action === "toggle debug") await saveDebugToggle(ctx, hooks);
      else if (action === "disable router" || action === "enable router") {
        await saveEnabled(ctx, hooks, action === "enable router");
      } else if (action === "show configuration") {
        ctx.ui.notify(formatConfig(hooks.getConfig()), "info");
      }
    },
  });
}
