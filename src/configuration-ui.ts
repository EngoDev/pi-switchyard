import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

import {
  writeConfigPatch,
  writeSwitchingPatch,
  type ConfigScope,
  type SwitchingConfigPatch,
} from "./config.js";
import { showPicker } from "./picker.js";
import {
  TIER_NAMES,
  type DebugMode,
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
      value: "temp-limits",
      label: "temp thread soft limits",
      description: `${config.tempThreadSoftTokenLimit.toLocaleString()} tokens · ${config.tempThreadSoftTurnLimit} turns`,
    },
    {
      value: "switching",
      label: "cache-aware model switching",
      description: config.switching.cacheAware
        ? `${config.switching.downgradeMode} · ${(config.switching.minSavingsRatio * 100).toFixed(0)}% / $${config.switching.minSavingsUsd} minimum savings`
        : "off",
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
  const lines = [
    `enabled: ${config.enabled}`,
    `debug: ${config.debug}`,
    `temp thread soft token limit: ${config.tempThreadSoftTokenLimit}`,
    `temp thread soft turn limit: ${config.tempThreadSoftTurnLimit}`,
    `cache-aware switching: ${config.switching.cacheAware}`,
    `downgrade confidence floor: ${config.switching.downgradeConfidenceFloor}`,
    `minimum switch savings ratio: ${config.switching.minSavingsRatio}`,
    `minimum switch savings USD: ${config.switching.minSavingsUsd}`,
    `unknown economics policy: ${config.switching.unknownCostPolicy}`,
    `assumed warm cache ratio: ${config.switching.assumedWarmCacheRatio}`,
    `assumed cache-write ratio: ${config.switching.assumedCacheWriteRatio}`,
    `default expected output tokens: ${config.switching.defaultExpectedOutputTokens}`,
    `downgrade mode: ${config.switching.downgradeMode}`,
    `evidence decay: ${config.switching.evidenceDecay}`,
    `minimum evidence score: ${config.switching.minimumEvidenceScore}`,
    `minimum evidence weight: ${config.switching.minimumEvidenceWeight}`,
    `hard requirement penalty: ${config.switching.hardRequirementPenalty}`,
    `forecast turns: ${config.switching.forecastTurns}`,
    `return probability floor: ${config.switching.returnProbabilityFloor}`,
    `return cost multiplier: ${config.switching.returnCostMultiplier}`,
    `economics overrides: ${Object.keys(config.switching.economics).length}`,
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
  reloadConfig(ctx: ExtensionCommandContext): void;
  onDebugChanged(ctx: ExtensionCommandContext): void;
  promotePending?(ctx: ExtensionCommandContext, token: string): Promise<void>;
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
  const selected = await showPicker(ctx, "Switchyard debug mode", [
    { value: "off", label: "off", description: "Hide routing and economics diagnostics" },
    { value: "minimal", label: "minimal", description: "One compact decision notification per request" },
    { value: "verbose", label: "verbose", description: "Full routing and economics audit block" },
  ], { maxVisible: 5, preselect: hooks.getConfig().debug });
  if (!selected) return;
  const scope = await chooseScope(ctx, "Save debug mode");
  if (!scope) return;
  const path = writeConfigPatch(ctx.cwd, scope, { debug: selected as DebugMode });
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(`Switchyard debug → ${hooks.getConfig().debug} · ${path}`, "info");
}

async function editTempLimits(ctx: ExtensionCommandContext, hooks: ConfigurationHooks): Promise<void> {
  const current = hooks.getConfig();
  const value = await ctx.ui.input(
    "Temp thread soft limits (tokens,turns; 0 disables a limit)",
    `${current.tempThreadSoftTokenLimit},${current.tempThreadSoftTurnLimit}`,
  );
  if (value === undefined) return;
  const match = value.trim().match(/^(\d+)\s*,\s*(\d+)$/);
  if (!match) {
    ctx.ui.notify("Enter two whole numbers separated by a comma, for example 32000,12", "error");
    return;
  }
  const tokenLimit = Number(match[1]);
  const turnLimit = Number(match[2]);
  if (!Number.isSafeInteger(tokenLimit) || !Number.isSafeInteger(turnLimit)) {
    ctx.ui.notify("Temp thread limits are too large", "error");
    return;
  }
  const scope = await chooseScope(ctx, "Save temp thread soft limits");
  if (!scope) return;
  const path = writeConfigPatch(ctx.cwd, scope, {
    tempThreadSoftTokenLimit: tokenLimit,
    tempThreadSoftTurnLimit: turnLimit,
  });
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(
    `Temp limits → ${hooks.getConfig().tempThreadSoftTokenLimit} tokens, ${hooks.getConfig().tempThreadSoftTurnLimit} turns · ${path}`,
    "info",
  );
}

async function saveSwitching(
  ctx: ExtensionCommandContext,
  hooks: ConfigurationHooks,
  switching: SwitchingConfigPatch,
): Promise<void> {
  const scope = await chooseScope(ctx, "Save cache-aware switching policy");
  if (!scope) return;
  const path = writeSwitchingPatch(ctx.cwd, scope, switching);
  finishConfigChange(ctx, hooks);
  ctx.ui.notify(`Switching policy updated · ${path}`, "info");
}

async function editSwitching(ctx: ExtensionCommandContext, hooks: ConfigurationHooks): Promise<void> {
  await runCategoryMenuLoop(
    () => {
      const policy = hooks.getConfig().switching;
      return showPicker(ctx, "Cache-aware model switching", [
        { value: "cache-aware", label: "cache-aware switching", description: String(policy.cacheAware) },
        { value: "mode", label: "downgrade mode", description: policy.downgradeMode },
        { value: "unknown", label: "unknown economics", description: policy.unknownCostPolicy },
        {
          value: "thresholds",
          label: "economics thresholds",
          description: `confidence ${policy.downgradeConfidenceFloor} · savings ${(policy.minSavingsRatio * 100).toFixed(0)}% / $${policy.minSavingsUsd}`,
        },
        {
          value: "evidence",
          label: "downgrade evidence",
          description: `score ${(policy.minimumEvidenceScore * 100).toFixed(0)}% · weight ${policy.minimumEvidenceWeight} · decay ${policy.evidenceDecay}`,
        },
        {
          value: "return-cost",
          label: "forecast and return reserve",
          description: `${policy.forecastTurns} turns · ${(policy.returnProbabilityFloor * 100).toFixed(0)}% floor · ${policy.returnCostMultiplier}x`,
        },
        {
          value: "estimation",
          label: "estimation defaults",
          description: `warm cache ${(policy.assumedWarmCacheRatio * 100).toFixed(0)}% · cache writes ${(policy.assumedCacheWriteRatio * 100).toFixed(0)}% · ${policy.defaultExpectedOutputTokens} output tokens`,
        },
        {
          value: "overrides",
          label: "economics overrides",
          description: `${Object.keys(policy.economics).length} configured in switchyard.json`,
        },
      ], { maxVisible: 11 });
    },
    async (selected) => {
      const policy = hooks.getConfig().switching;
      if (selected === "cache-aware") {
        const value = await showPicker(ctx, "Enable cache-aware switching", [
          { value: "true", label: "true" },
          { value: "false", label: "false" },
        ], { maxVisible: 4, preselect: String(policy.cacheAware) });
        if (!value) return;
        await saveSwitching(ctx, hooks, { cacheAware: value === "true" });
      } else if (selected === "mode") {
        const value = await showPicker(ctx, "Downgrade execution mode", [
          { value: "enforce", label: "enforce", description: "Apply proven economical downgrades" },
          { value: "shadow", label: "shadow", description: "Calculate and report without switching" },
        ], { maxVisible: 4, preselect: policy.downgradeMode });
        if (!value) return;
        await saveSwitching(ctx, hooks, { downgradeMode: value as "enforce" | "shadow" });
      } else if (selected === "unknown") {
        const value = await showPicker(ctx, "When model economics are unknown", [
          { value: "stay", label: "stay", description: "Preserve the incumbent model" },
          { value: "switch", label: "switch", description: "Use Jev's candidate" },
        ], { maxVisible: 4, preselect: policy.unknownCostPolicy });
        if (!value) return;
        await saveSwitching(ctx, hooks, { unknownCostPolicy: value as "stay" | "switch" });
      } else if (selected === "thresholds") {
        const value = await ctx.ui.input(
          "Downgrade confidence,min savings ratio,min savings USD",
          `${policy.downgradeConfidenceFloor},${policy.minSavingsRatio},${policy.minSavingsUsd}`,
        );
        if (value === undefined) return;
        const parts = value.split(",").map((part) => Number(part.trim()));
        if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
          ctx.ui.notify("Enter three non-negative numbers, for example 0.7,0.2,0.001", "error");
          return;
        }
        await saveSwitching(ctx, hooks, {
          downgradeConfidenceFloor: Math.min(1, parts[0]!),
          minSavingsRatio: Math.min(1, parts[1]!),
          minSavingsUsd: parts[2]!,
        });
      } else if (selected === "evidence") {
        const value = await ctx.ui.input(
          "Evidence decay,min score,min weight,hard requirement penalty",
          `${policy.evidenceDecay},${policy.minimumEvidenceScore},${policy.minimumEvidenceWeight},${policy.hardRequirementPenalty}`,
        );
        if (value === undefined) return;
        const parts = value.split(",").map((part) => Number(part.trim()));
        if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
          ctx.ui.notify("Enter four non-negative numbers, for example 0.8,0.65,1.5,1.5", "error");
          return;
        }
        await saveSwitching(ctx, hooks, {
          evidenceDecay: Math.min(1, parts[0]!),
          minimumEvidenceScore: Math.min(1, parts[1]!),
          minimumEvidenceWeight: parts[2]!,
          hardRequirementPenalty: parts[3]!,
        });
      } else if (selected === "return-cost") {
        const value = await ctx.ui.input(
          "Forecast turns,return probability floor,return cost multiplier",
          `${policy.forecastTurns},${policy.returnProbabilityFloor},${policy.returnCostMultiplier}`,
        );
        if (value === undefined) return;
        const parts = value.split(",").map((part) => Number(part.trim()));
        if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
          ctx.ui.notify("Enter three non-negative numbers, for example 3,0.25,1", "error");
          return;
        }
        await saveSwitching(ctx, hooks, {
          forecastTurns: Math.max(1, Math.trunc(parts[0]!)),
          returnProbabilityFloor: Math.min(1, parts[1]!),
          returnCostMultiplier: parts[2]!,
        });
      } else if (selected === "estimation") {
        const value = await ctx.ui.input(
          "Assumed warm cache ratio,cache-write ratio,default expected output tokens",
          `${policy.assumedWarmCacheRatio},${policy.assumedCacheWriteRatio},${policy.defaultExpectedOutputTokens}`,
        );
        if (value === undefined) return;
        const parts = value.split(",").map((part) => Number(part.trim()));
        if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
          ctx.ui.notify("Enter three non-negative numbers, for example 0.75,0.5,800", "error");
          return;
        }
        await saveSwitching(ctx, hooks, {
          assumedWarmCacheRatio: Math.min(1, parts[0]!),
          assumedCacheWriteRatio: Math.min(1, parts[1]!),
          defaultExpectedOutputTokens: Math.trunc(parts[2]!),
        });
      } else if (selected === "overrides") {
        ctx.ui.notify("Edit switching.economics in switchyard.json; values override Pi model pricing.", "info");
      }
    },
  );
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
      { maxVisible: 11 },
    ),
    async (selected) => {
      if (selected.startsWith("tier:")) {
        await editTier(ctx, hooks, selected.slice("tier:".length) as TierName);
      } else if (selected === "debug") {
        await editDebug(ctx, hooks);
      } else if (selected === "enabled") {
        await editEnabled(ctx, hooks);
      } else if (selected === "temp-limits") {
        await editTempLimits(ctx, hooks);
      } else if (selected === "switching") {
        await editSwitching(ctx, hooks);
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
      if (direct.startsWith("__promote ")) {
        await hooks.promotePending?.(ctx, direct.slice("__promote ".length).trim());
      } else if ((TIER_NAMES as readonly string[]).includes(direct)) {
        await editTier(ctx, hooks, direct as TierName);
      } else if (!direct || direct === "configure") {
        await showCategoryMenu(ctx, hooks);
      } else if (direct === "debug") {
        await editDebug(ctx, hooks);
      } else if (direct === "limits") {
        await editTempLimits(ctx, hooks);
      } else if (direct === "switching") {
        await editSwitching(ctx, hooks);
      } else if (direct === "on" || direct === "off") {
        await saveEnabled(ctx, hooks, direct === "on");
      } else if (direct === "show") {
        ctx.ui.notify(formatConfig(hooks.getConfig()), "info");
      } else {
        ctx.ui.notify("Usage: /switchyard [genius|smart|handy|cheap|debug|limits|switching|on|off|show]", "error");
      }
    },
  });
}
