---
name: fiction-translation
description: Evidence-based literary translation with stable character voices, directional relationship speech rules, approved original-translation anchors, and independent reviewer checks.
version: 2
---

# Fiction Translation Workflow

Use this skill only for literary documents (novels, stories, memoir, dialogue-heavy nonfiction). It is a workflow contract, not an instruction to create a separate agent for each character.

## Required order

1. **Read source structure.** Keep each stable segment ID, source text, chapter path, and page/layout markers. Never put book memory into `contextPath`; that field is source-document structure only.
2. **Load the immutable memory snapshot.** A run pins a `literary_memory_revision_id`. Use its confirmed entity mappings, confirmed character profiles, confirmed directional relationship rules, and approved voice anchors as read-only data.
3. **Translate the batch.** Select a compact, batch-relevant `voiceContext`, including the matching chapter summary and up to two preceding summaries only when the current chapter can be identified reliably. If chapter names do not align, omit chapter summaries rather than risk leaking unrelated or later plot events. Do not send the entire novel, entire memory, or all voice anchors for every batch. Never infer a speaker merely because a name appears nearby. Current source segments always outrank summaries; summaries must not add facts to the translation.
4. **Validate the result.** Preserve one output per input ID, order/segment boundaries, negation, tense, viewpoint, referents, ambiguity, and plot facts. Do not add catchphrases, dialect, swearing, emotions, metaphors, or facts absent from the source merely to make a character sound distinctive.
5. **Review separately.** Check meaning/plot accuracy, terminology, narrative style, and character voice. Character-voice findings should cite the exact source/draft evidence and the relevant confirmed profile or directional relationship rule. If speaker/addressee attribution is uncertain, report the uncertainty instead of forcing a profile.
6. **Gate changes.** Accuracy and terminology findings may follow the existing must-fix workflow. Style and character-voice revisions remain candidate proposals until explicitly accepted. Model output cannot mark a profile or anchor as user-approved.
7. **Persist evidence and outcome.** Save candidates, findings, source/Prompt/memory revision IDs, run events, and explicit user acceptance in the document project. Do not overwrite a confirmed profile or approved anchor when new chapter analysis disagrees.

## Memory contract

- `characterVoices`: stable `characterId`, canonical source name, aliases, status, voiceCore, contrastRules, evidence, openQuestions.
- `relationshipVoiceRules`: directional speaker → addressee, address terms, baseline register, directness, emotional distance, scene-dependent shifts, source evidence IDs.
- `voiceAnchors`: short original/accepted-translation pairs tied to a real segment and speaker. Only `status=approved` anchors enter normal translation context.
- All generated records start as `candidate`. A voice profile requires at least one source quote that matches its referenced segment. A voice anchor additionally requires `attributionEvidence` to match the same source segment and `attributionConfidence >= 0.7`; approval also requires a confirmed speaker profile and an anchor target that occurs in the current accepted translation for that segment. The Project Store revalidates these conditions server-side.
- Merge is conservative: user-confirmed voice cores and user-approved/rejected states survive future analysis. Conflicting new observations create an open question instead of silently changing the profile.
- Keep memory as an independent immutable revision, not a growing static Prompt. Each Run references the exact memory revision used.

## Output and caching

- Put voice data into an explicit read-only user-data field named `voiceContext`; never concatenate it into `contextPath`. For dialogue/coreference disambiguation, pass at most four preceding source segments in a separate read-only `precedingSegments` field; do not ask the model to translate or return IDs for them.
- Bound by removing lower-priority complete records, not by slicing serialized JSON.
- Include the voice-context and preceding-context/policy hash in the literary translation cache key, including caller-supplied keys. The current policy version is `character-voice-v3`. Keep non-literary/web cache keys unchanged.
- Record policy version and memory revision with each run. Never reuse a candidate produced with a different source hash, static Prompt, or voice context when deciding whether a result is current.

## Review checklist

Before completing a literary batch, ask:
- Is the speaker/addressee actually supported by the source and scene?
- Does this line differ from that character's confirmed baseline in register, syntax/rhythm, lexical preferences, discourse habit, stance/modality, humor/irony, or disfluency?
- Does the difference have textual evidence, or is it an unsupported stereotype?
- Is a relationship rule directional and scene-appropriate?
- Is the proposed change more faithful and readable without adding content?
- Has the model kept the current translation if the finding is merely stylistic and not accepted?

When there is no reliable character-voice evidence, prefer a faithful, natural translation over an invented voice signature.
