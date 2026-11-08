/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, UIKitMLAsset } from '@iwsdk/core';
import { IncidentSocket, type ConnectionStatus } from './incident-client.js';
import type { IncidentState, Report } from './incident-types.js';

const MAX_SLOTS = 8;

/** The panel font only ships ASCII glyphs; map common typographic characters so server text never renders as boxes. */
function panelText(text: string): string {
  return text
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E]/g, '');
}
const CALLER_BORDER = '#3a7bd5';
const CALLER_BG = '#1a2430';
const FIREFIGHTER_BORDER = '#c2502f';
const FIREFIGHTER_BORDER_ACTIVE = '#ff8f6b';
const FIREFIGHTER_BG = '#2a1c17';

type FirefighterStatus = 'dispatched' | 'en route' | 'on scene';
const FIREFIGHTER_PROGRESSION: { status: FirefighterStatus; afterMs: number }[] = [
  { status: 'dispatched', afterMs: 0 },
  { status: 'en route', afterMs: 3000 },
  { status: 'on scene', afterMs: 9000 },
];

/**
 * Owns the voice/comms panel roster and the resources panel stats, driven by
 * the real Firewatch server over its WebSocket: callers from state.reports,
 * people-at-risk from state.exits. There is no "firefighter unit" concept in
 * the shared contract (server/API.md: dispatch is logged only, for now), so
 * that half stays a simulated single-unit dispatch, triggered by confirmed server dispatch records. Acceptance and dispatch
 * require explicit operator button presses.
 */
export class ConsoleSystem extends createSystem({}) {
  private voicePanel: UIKitMLAsset | null = null;
  private resourcesPanel: UIKitMLAsset | null = null;
  private slotRoots: ReturnType<UIKitMLAsset['getElementById']>[] = [];
  private slotLabels: ReturnType<UIKitMLAsset['getElementById']>[] = [];
  private slotStatuses: ReturnType<UIKitMLAsset['getElementById']>[] = [];

  private socket: IncidentSocket | null = null;
  private latestState: IncidentState | null = null;
  private connection: ConnectionStatus = 'connecting';
  private lastDispatchTime: number | null = null;
  private actionPending: 'accept' | 'dispatch' | null = null;
  private firefighterStatus: FirefighterStatus | null = null;
  private firefighterTimers: ReturnType<typeof setTimeout>[] = [];

  init(): void {
    this.voicePanel =
      this.world.getSceneObject<UIKitMLAsset>('voice-panel') ?? null;
    this.resourcesPanel =
      this.world.getSceneObject<UIKitMLAsset>('resources-panel') ?? null;

    for (let i = 0; i < MAX_SLOTS; i++) {
      this.slotRoots.push(this.voicePanel?.getElementById(`slot-${i}`) ?? null);
      this.slotLabels.push(
        this.voicePanel?.getElementById(`slot-${i}-label`) ?? null,
      );
      this.slotStatuses.push(
        this.voicePanel?.getElementById(`slot-${i}-status`) ?? null,
      );
    }

    this.socket = new IncidentSocket((state) => this.onState(state), (status) => {
      this.connection = status;
      if (status !== 'connected') this.actionPending = null;
      this.render();
    });
    const acceptButton = this.resourcesPanel?.getElementById('accept-recommendation-button');
    const dispatchButton = this.resourcesPanel?.getElementById('dispatch-button');
    const accept = () => {
      if (!this.latestState?.recommendation || this.actionPending) return;
      if (this.socket?.send({ type: 'acceptRecommendation' })) this.actionPending = 'accept';
      this.render();
    };
    const dispatch = () => {
      const roomId = this.latestState?.origin?.roomId;
      if (!roomId || this.actionPending) return;
      if (this.socket?.send({ type: 'dispatch', roomId })) this.actionPending = 'dispatch';
      this.render();
    };
    acceptButton?.addEventListener('click', accept);
    dispatchButton?.addEventListener('click', dispatch);
    this.cleanupFuncs.push(
      () => acceptButton?.removeEventListener('click', accept),
      () => dispatchButton?.removeEventListener('click', dispatch),
      () => this.stop(),
    );
    this.socket.connect();
    this.render();
  }

  stop(): void {
    this.socket?.close();
    for (const timer of this.firefighterTimers) {
      clearTimeout(timer);
    }
  }

  private onState(state: IncidentState): void {
    this.latestState = state;

    this.actionPending = null;
    const dispatches = state.dispatches ?? [];
    const lastDispatch = dispatches[dispatches.length - 1];
    if (!lastDispatch) {
      this.lastDispatchTime = null;
      this.firefighterStatus = null;
      for (const timer of this.firefighterTimers) clearTimeout(timer);
      this.firefighterTimers = [];
    } else if (lastDispatch.time !== this.lastDispatchTime) {
      this.lastDispatchTime = lastDispatch.time;
      this.startFirefighterDispatch(lastDispatch.time);
    }

    this.render();
  }

  private startFirefighterDispatch(dispatchedAt: number): void {
    for (const timer of this.firefighterTimers) {
      clearTimeout(timer);
    }
    this.firefighterTimers = [];

    const elapsed = Math.max(0, Date.now() - dispatchedAt);
    this.firefighterStatus = 'dispatched';
    for (const step of FIREFIGHTER_PROGRESSION) {
      if (step.afterMs <= elapsed) {
        this.firefighterStatus = step.status;
      } else {
        this.firefighterTimers.push(setTimeout(() => {
          this.firefighterStatus = step.status;
          this.render();
        }, step.afterMs - elapsed));
      }
    }
  }

  private recentCallers(): Report[] {
    const reports = this.latestState?.reports ?? [];
    const byCallerMostRecent = new Map<string, Report>();
    for (const report of reports) {
      const existing = byCallerMostRecent.get(report.caller);
      if (existing == null || report.time >= existing.time) {
        byCallerMostRecent.set(report.caller, report);
      }
    }
    return [...byCallerMostRecent.values()]
      .sort((a, b) => b.time - a.time)
      .slice(0, this.firefighterStatus != null ? MAX_SLOTS - 1 : MAX_SLOTS);
  }

  private render(): void {
    this.renderVoicePanel();
    this.renderResourcesPanel();
    this.renderServerControls();
  }

  private renderVoicePanel(): void {
    const callers = this.recentCallers();
    let slot = 0;

    for (const report of callers) {
      const text = panelText(report.text);
      this.setSlot(slot, {
        isFirefighter: false,
        label: panelText(report.roomId ?? report.caller),
        status: text.length > 40 ? `${text.slice(0, 40)}...` : text,
      });
      slot++;
    }

    if (this.firefighterStatus != null) {
      this.setSlot(slot, {
        isFirefighter: true,
        label: 'Engine 3',
        status: this.firefighterStatus,
      });
      slot++;
    }

    for (; slot < MAX_SLOTS; slot++) {
      this.slotRoots[slot]?.setProperties({ display: 'none' });
    }
  }

  private setSlot(
    index: number,
    entry: { isFirefighter: boolean; label: string; status: string },
  ): void {
    const active = entry.isFirefighter && entry.status === 'on scene';
    this.slotRoots[index]?.setProperties({
      display: 'flex',
      borderColor: entry.isFirefighter
        ? active
          ? FIREFIGHTER_BORDER_ACTIVE
          : FIREFIGHTER_BORDER
        : CALLER_BORDER,
      backgroundColor: entry.isFirefighter ? FIREFIGHTER_BG : CALLER_BG,
    });
    this.slotLabels[index]?.setProperties({ text: entry.label });
    this.slotStatuses[index]?.setProperties({ text: entry.status });
  }

  private renderServerControls(): void {
    const connected = this.connection === 'connected';
    const panel = this.resourcesPanel;
    const pending = this.latestState?.recommendation;
    panel?.getElementById('connection-status')?.setProperties({
      text: connected ? 'Server connected' : this.connection === 'reconnecting' ? 'Reconnecting - showing last state' : 'Connecting to server',
      color: connected ? '#64d9aa' : '#ffca7a',
    });
    panel?.getElementById('recommendation-text')?.setProperties({
      text: panelText(pending?.actions.join(' / ') ?? this.latestState?.accepted?.recommendation.actions.join(' / ') ?? 'Waiting for an incident recommendation.'),
    });
    panel?.getElementById('recommendation-status')?.setProperties({
      text: this.actionPending ? 'Sending to server...' : pending ? 'Awaiting your approval' : this.latestState?.accepted ? 'Recommendation accepted' : 'No pending recommendation',
    });
    panel?.getElementById('accept-recommendation-button')?.setProperties({ disabled: !connected || !pending || this.actionPending != null });
    panel?.getElementById('dispatch-button')?.setProperties({ disabled: !connected || !this.latestState?.origin || this.actionPending != null });
  }

  private renderResourcesPanel(): void {
    const dispatched = this.firefighterStatus === 'dispatched' ? 1 : 0;
    const enRoute = this.firefighterStatus === 'en route' ? 1 : 0;
    const onScene = this.firefighterStatus === 'on scene' ? 1 : 0;

    const peopleAtRisk = (this.latestState?.exits ?? []).reduce(
      (sum, exit) => (exit.atRiskAt != null ? sum + exit.people : sum),
      0,
    );

    this.resourcesPanel
      ?.getElementById('stat-dispatched-count')
      ?.setProperties({ text: String(dispatched) });
    this.resourcesPanel
      ?.getElementById('stat-enroute-count')
      ?.setProperties({ text: String(enRoute) });
    this.resourcesPanel
      ?.getElementById('stat-onscene-count')
      ?.setProperties({ text: String(onScene) });
    this.resourcesPanel
      ?.getElementById('stat-people-at-risk')
      ?.setProperties({ text: String(peopleAtRisk) });
  }
}
