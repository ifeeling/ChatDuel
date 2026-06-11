# History Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local history foundation so every unified composer send creates a session record with target platforms, final prompt, attachment metadata, and response placeholders.

**Architecture:** Keep the first slice small. Upgrade shared session types and `session-store`, add focused helpers for creating/updating session records, then call those helpers from `chat.ts` at the start and end of `onSend()`. History UI, summary UI, multi-round summaries, and document file attachments remain later tasks.

**Tech Stack:** TypeScript, Chrome extension MV3, `chrome.storage.local`, Vitest, jsdom.

---

## Files

- Modify: `src/types/index.ts`
  - Add `SessionResponse`, `SessionAttachment`, `SessionSummary`, status fields, `updatedAt`, `sentPrompt`, `targetPlatforms`.
- Modify: `src/lib/session-store.ts`
  - Add `updateSession(session)`.
  - Keep existing `addSession`, `loadSessions`, `getSession`, `deleteSession`.
- Create: `src/lib/session-record.ts`
  - Small helper to create a session from prompt, targets, and optional image attachment.
  - Small helper to mark send results as `pending` / `failed`.
- Modify: `tests/unit/session-store.test.ts`
  - Update fixture type.
  - Add failing test for `updateSession`.
- Create: `tests/unit/session-record.test.ts`
  - Test session creation shape and send-result updates.
- Modify: `src/chat/chat.ts`
  - Import `addSession`, `updateSession`, and session helper functions.
  - Create session before sending to iframes.
  - Update response placeholders after send result collection.

---

## Task 1: Upgrade Session Types And Store

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/session-store.ts`
- Modify: `tests/unit/session-store.test.ts`

- [x] **Step 1: Write failing store test**

Add this test to `tests/unit/session-store.test.ts`:

```ts
it('updateSession replaces an existing session and refreshes updatedAt', async () => {
  const original = make('update', 'before')
  await addSession(original)

  await updateSession({
    ...original,
    prompt: 'after',
    sentPrompt: 'after',
    updatedAt: original.updatedAt + 10,
  })

  const saved = await getSession('update')
  expect(saved?.prompt).toBe('after')
  expect(saved?.sentPrompt).toBe('after')
  expect(saved?.updatedAt).toBe(original.updatedAt + 10)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/session-store.test.ts`

Expected: FAIL because `updateSession` is not exported.

- [x] **Step 3: Update `src/types/index.ts` minimally**

Add the new type interfaces while preserving `summary?: string` for compatibility.

- [x] **Step 4: Implement `updateSession`**

In `src/lib/session-store.ts`, replace a matching id, evict if needed, and write back. If the id does not exist, append it.

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/unit/session-store.test.ts`

Expected: PASS.

---

## Task 2: Add Session Record Helpers

**Files:**
- Create: `src/lib/session-record.ts`
- Create: `tests/unit/session-record.test.ts`

- [x] **Step 1: Write failing helper tests**

Test these behaviors:

```ts
it('creates a session with target platforms and pending responses', () => {
  const session = createSessionRecord({
    prompt: 'hello',
    sentPrompt: 'hello',
    targetPlatforms: ['chatgpt', 'gemini'],
    now: 1000,
    id: 's1',
  })

  expect(session.id).toBe('s1')
  expect(session.createdAt).toBe(1000)
  expect(session.updatedAt).toBe(1000)
  expect(session.prompt).toBe('hello')
  expect(session.sentPrompt).toBe('hello')
  expect(session.targetPlatforms).toEqual(['chatgpt', 'gemini'])
  expect(session.responses.chatgpt?.status).toBe('pending')
  expect(session.responses.gemini?.status).toBe('pending')
})

it('marks failed send targets and leaves successful targets pending', () => {
  const session = createSessionRecord({
    prompt: 'hello',
    sentPrompt: 'hello',
    targetPlatforms: ['chatgpt', 'gemini'],
    now: 1000,
    id: 's1',
  })

  const updated = applySendResults(session, [
    { p: 'chatgpt', ok: true },
    { p: 'gemini', ok: false },
  ], 2000)

  expect(updated.updatedAt).toBe(2000)
  expect(updated.responses.chatgpt?.status).toBe('pending')
  expect(updated.responses.gemini?.status).toBe('failed')
  expect(updated.responses.gemini?.error).toBe('send failed')
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/session-record.test.ts`

Expected: FAIL because `session-record.ts` does not exist.

- [x] **Step 3: Implement helper module**

Create `createSessionRecord()` and `applySendResults()` with no DOM dependency.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/session-record.test.ts`

Expected: PASS.

---

## Task 3: Write History On Composer Send

**Files:**
- Modify: `src/chat/chat.ts`

- [x] **Step 1: Import store and helper functions**

Use:

```ts
import { addSession, updateSession } from '../lib/session-store'
import { applySendResults, createSessionRecord } from '../lib/session-record'
```

- [x] **Step 2: Create session before iframe send**

In `onSend()`, after targets are resolved and image metadata is available, create a session:

```ts
let currentSession = createSessionRecord({
  prompt: text,
  sentPrompt: text,
  targetPlatforms: targets,
  attachments,
})
await addSession(currentSession)
```

- [x] **Step 3: Record image attachment metadata**

If `pendingImage` exists, include one attachment with `kind: 'image'`, `handling: 'file-upload'`, `uploadStatus: 'pending'`, name, mime, and size.

- [x] **Step 4: Update session after send results**

After `results` is collected:

```ts
currentSession = applySendResults(currentSession, results)
await updateSession(currentSession)
```

- [x] **Step 5: Verify**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0.

---

## Out Of Scope For This Plan

- History list/detail UI.
- Summary dialog and summary sending.
- Reading latest AI responses into history.
- Text/document file attachments.
- `conversationId` grouping beyond storing the optional field.
