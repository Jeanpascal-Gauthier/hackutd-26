/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, UIKitMLAsset } from '@iwsdk/core';
import { IncidentSocket } from './incident-client.js';
import type { IncidentState, Report } from './incident-types.js';

const MAX_SLOTS = 8;
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
 * the real FireSight server over its WebSocket: callers from state.reports,
 * people-at-risk from state.exits. There is no "firefighter unit" concept in
 * the shared contract (server/API.md: dispatch is logged only, for now), so
 * that half stays a simulated single-unit dispatch, triggered by a real
 * state.recommendation appearing rather than a fixed timer.
 */
export class ConsoleSystem extends createSystem({}) {
  private voicePanel: UIKitMLAsset | null = null;
  private resourcesPanel: UIKitMLAsset | null = null;
  private slotRoots: ReturnType<UIKitMLAsset['getElementById']>[] = [];
  private slotLabels: ReturnType<UIKitMLAsset['getElementById']>[] = [];
  private slotStatuses: ReturnType<UIKitMLAsset['getElementById']>[] = [];

  private socket: IncidentSocket | null = null;
  private latestState: IncidentState | null = null;
  private lastRecommendationKey: string | null = null;
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

    this.socket = new IncidentSocket((state) => this.onState(state));
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

    const recommendationKey = state.recommendation
      ? JSON.stringify(state.recommendation)
      : null;
    if (recommendationKey != null && recommendationKey !== this.lastRecommendationKey) {
      this.lastRecommendationKey = recommendationKey;
      this.startFirefighterDispatch(state.origin?.roomId);
    }

    this.render();
  }

  private startFirefighterDispatch(roomId: string | undefined): void {
    for (const timer of this.firefighterTimers) {
      clearTimeout(timer);
    }
    this.firefighterTimers = [];

    for (const step of FIREFIGHTER_PROGRESSION) {
      const timer = setTimeout(() => {
        this.firefighterStatus = step.status;
        this.render();
      }, step.afterMs);
      this.firefighterTimers.push(timer);
    }

    if (roomId != null) {
      this.socket?.send({ type: 'dispatch', roomId });
    }
    // Closes the loop so the server moves recommendation -> accepted and
    // BuildingSystem lights the evacuation route green (server/API.md).
    // No separate "accept" UI yet; the commander's real approval step is a
    // natural next addition once there's a button to wire it to.
    this.socket?.send({ type: 'acceptRecommendation' });
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
  }

  private renderVoicePanel(): void {
    const callers = this.recentCallers();
    let slot = 0;

    for (const report of callers) {
      this.setSlot(slot, {
        isFirefighter: false,
        label: report.roomId ?? report.caller,
        status: report.text.length > 40 ? `${report.text.slice(0, 40)}...` : report.text,
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
