import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { loadReplayManifest, validateReplayManifest, ReplayManifestError } from './validate-replay.mjs'

const root = path.resolve(import.meta.dirname)
const manifestFile = path.join(root, 'replay-manifest.json')
const journeyDir = path.join(root, 'journeys')

test('versioned replay manifest covers every frozen journey with explicit stimuli', () => {
  const manifest = loadReplayManifest(manifestFile, journeyDir)
  assert.equal(manifest.manifestVersion, 1)
  assert.equal(Object.keys(manifest.journeys).length, 25)
})

test('replay validation rejects missing, extra, and mismatched mappings', () => {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  assert.throws(() => validateReplayManifest({ ...manifest, journeys: { ...manifest.journeys, extra: manifest.journeys['homepage-direct'] } }, []), ReplayManifestError)
  const one = [{ journey: { id: 'x', turns: [{ action: 'chat', message: 'declared' }] } }]
  assert.throws(() => validateReplayManifest({ manifestVersion: 1, journeys: { x: { turns: [{ turn: 1, action: 'answer', message: 'x' }] } } }, one), /mismatch/)
})

test('replay validation detects drift in declared fields and action-incompatible extras', () => {
  const journey = [{ journey: { id: 'x', turns: [
    { action: 'chat', message: 'hello' },
    { action: 'answer', answers: [{ key: 'style', optionId: 'minimal' }] },
    { action: 'confirm_generation', approvalId: 'approval-x' },
  ] } }]
  const base = { manifestVersion: 1, journeys: { x: { turns: [
    { turn: 1, action: 'chat', message: 'hello' },
    { turn: 2, action: 'answer', answers: [{ key: 'style', optionId: 'minimal' }] },
    { turn: 3, action: 'confirm_generation', approvalId: 'approval-x' },
  ] } } }
  for (const field of ['message', 'answers', 'approvalId']) {
    const drift = structuredClone(base)
    const turnIndex = field === 'message' ? 0 : field === 'answers' ? 1 : 2
    drift.journeys.x.turns[turnIndex][field] = field === 'answers' ? [{ key: 'style', optionId: 'maximal' }] : 'changed'
    assert.throws(() => validateReplayManifest(drift, journey), /mismatch/)
  }
  const extra = structuredClone(base)
  extra.journeys.x.turns[0].approvalId = 'wrong-action'
  assert.throws(() => validateReplayManifest(extra, journey), /mismatch/)
  const credential = structuredClone(base)
  credential.journeys.x.turns[0].message = '{"nested":{"access_token":"secret-value"}}'
  const credentialJourney = structuredClone(journey)
  credentialJourney[0].journey.turns[0].message = credential.journeys.x.turns[0].message
  assert.throws(() => validateReplayManifest(credential, credentialJourney), /credential-like/)
  const replayOnly = [{ journey: { id: 'x', turns: [{ action: 'chat' }] } }]
  assert.throws(() => validateReplayManifest({ manifestVersion: 1, journeys: { x: { turns: [{ turn: 1, action: 'chat' }] } } }, replayOnly), /stimulus|message/)
  assert.doesNotThrow(() => validateReplayManifest({ manifestVersion: 1, journeys: { x: { turns: [{ turn: 1, action: 'chat', stimulus: { message: 'explicit' } }] } } }, replayOnly))
})
