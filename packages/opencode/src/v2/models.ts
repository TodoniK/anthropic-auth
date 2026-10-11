import {
  isClaudeFable51Model,
  isClaudeHaiku55Model,
  isClaudeOpus5FamilyModel,
  isClaudeSonnet55Model,
} from '@cortexkit/anthropic-auth-core'
import type { Model, Plugin } from '@opencode/plugin'

/** Each model variant supplies request settings for adaptive thinking and its selected reasoning effort. */
export function createNativeClaudeModelRules() {
  const ids = new Map<string, string>()
  const install = (ctx: Pick<Plugin.Context, 'model'>) =>
    ctx.model.transform((editor) => {
      ids.clear()
      for (const candidate of editor.list('anthropic')) {
        ids.set(String(candidate.id), String(candidate.modelID))
        if (
          !(
            isClaudeFable51Model(candidate.modelID) ||
            isClaudeOpus5FamilyModel(candidate.modelID) ||
            isClaudeSonnet55Model(candidate.modelID) ||
            isClaudeHaiku55Model(candidate.modelID)
          )
        )
          continue
        editor.update('anthropic', String(candidate.id), (model) => {
          const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
          const retained = model.variants.filter(
            (variant) =>
              !efforts.some((effort) => effort === String(variant.id)),
          )
          model.variants = [
            ...retained,
            ...efforts.map((effort) => ({
              id: effort as Model.VariantID,
              settings: {
                effort,
                thinking: { type: 'adaptive', display: 'summarized' },
              },
            })),
          ]
        })
      }
    })
  return { install, modelId: (id: string) => ids.get(id) ?? id }
}
