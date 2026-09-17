import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { writeConfig, type ConfigScope } from "./config.js";
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
  const selected = await ctx.ui.select(
    `${tier}: choose model`,
    [...byLabel.keys()],
  );
  return selected ? byLabel.get(selected) : undefined;
}

async function chooseThinking(
  ctx: ExtensionCommandContext,
  tier: TierName,
  model: Model<any>,
): Promise<ThinkingSelection | undefined> {
  const values = getThinkingSelections(model);
  const selected = await ctx.ui.select(
    `${tier}: thinking for ${model.provider}/${model.id}`,
    values,
  );
  return selected as ThinkingSelection | undefined;
}

function formatConfig(config: RouterConfig): string {
  const lines = [
    `enabled: ${config.enabled}`,
    `debug: ${config.debug}`,
  ];
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
  setConfig(config: RouterConfig): void;
  onDebugChanged(ctx: ExtensionCommandContext): void;
}

async function runConfigurationWizard(
  ctx: ExtensionCommandContext,
  hooks: ConfigurationHooks,
): Promise<void> {
  const scope = await ctx.ui.select("Save Jev router configuration", ["global", "project"]);
  if (!scope) return;
  if (scope === "project" && !ctx.isProjectTrusted()) {
    ctx.ui.notify("Project configuration requires a trusted project", "error");
    return;
  }

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

  const next: RouterConfig = {
    ...hooks.getConfig(),
    version: 1,
    enabled: true,
    debug: debugSelection === "true",
    tiers,
  };
  const path = writeConfig(ctx.cwd, scope as ConfigScope, next);
  hooks.setConfig(next);
  hooks.onDebugChanged(ctx);
  ctx.ui.notify(`Saved Jev router configuration to ${path}`, "info");
}

export function registerConfigurationCommand(pi: ExtensionAPI, hooks: ConfigurationHooks): void {
  pi.registerCommand("jev-router", {
    description: "Configure and inspect the Jev session/model router",
    handler: async (args, ctx) => {
      const direct = args.trim().toLowerCase();
      if (direct === "configure") {
        await runConfigurationWizard(ctx, hooks);
        return;
      }
      if (direct === "debug") {
        const current = hooks.getConfig();
        const next = { ...current, debug: !current.debug };
        const scope = await ctx.ui.select("Save debug setting", ["global", "project"]);
        if (!scope) return;
        if (scope === "project" && !ctx.isProjectTrusted()) {
          ctx.ui.notify("Project configuration requires a trusted project", "error");
          return;
        }
        const path = writeConfig(ctx.cwd, scope as ConfigScope, next);
        hooks.setConfig(next);
        hooks.onDebugChanged(ctx);
        ctx.ui.notify(`Jev router debug ${next.debug ? "enabled" : "disabled"} (${path})`, "info");
        return;
      }
      if (direct === "on" || direct === "off") {
        const next = { ...hooks.getConfig(), enabled: direct === "on" };
        const scope = await ctx.ui.select("Save enabled setting", ["global", "project"]);
        if (!scope) return;
        if (scope === "project" && !ctx.isProjectTrusted()) {
          ctx.ui.notify("Project configuration requires a trusted project", "error");
          return;
        }
        const path = writeConfig(ctx.cwd, scope as ConfigScope, next);
        hooks.setConfig(next);
        hooks.onDebugChanged(ctx);
        ctx.ui.notify(`Jev router ${next.enabled ? "enabled" : "disabled"} (${path})`, "info");
        return;
      }
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
      else if (action === "toggle debug") {
        const next = { ...hooks.getConfig(), debug: !hooks.getConfig().debug };
        const scope = await ctx.ui.select("Save debug setting", ["global", "project"]);
        if (!scope) return;
        if (scope === "project" && !ctx.isProjectTrusted()) {
          ctx.ui.notify("Project configuration requires a trusted project", "error");
          return;
        }
        writeConfig(ctx.cwd, scope as ConfigScope, next);
        hooks.setConfig(next);
        hooks.onDebugChanged(ctx);
      } else if (action === "disable router" || action === "enable router") {
        const next = { ...hooks.getConfig(), enabled: action === "enable router" };
        const scope = await ctx.ui.select("Save enabled setting", ["global", "project"]);
        if (!scope) return;
        if (scope === "project" && !ctx.isProjectTrusted()) {
          ctx.ui.notify("Project configuration requires a trusted project", "error");
          return;
        }
        writeConfig(ctx.cwd, scope as ConfigScope, next);
        hooks.setConfig(next);
        hooks.onDebugChanged(ctx);
      } else if (action === "show configuration") {
        ctx.ui.notify(formatConfig(hooks.getConfig()), "info");
      }
    },
  });
}
