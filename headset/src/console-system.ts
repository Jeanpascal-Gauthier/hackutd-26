/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createSystem, UIKitMLAsset } from '@iwsdk/core';
import { FloorState } from './floor-component.js';

type ParticipantKind = 'caller' | 'firefighter';

interface Participant {
  kind: ParticipantKind;
  label: string;
  status: string;
  speaking: boolean;
}

const MAX_SLOTS = 8;
const AT_RISK_THRESHOLD = 0.3;
const PEOPLE_PER_AT_RISK_FLOOR = 8;

const CALLER_BORDER = '#3a7bd5';
const CALLER_BORDER_SPEAKING = '#8fc2ff';
const CALLER_BG = '#1a2430';
const FIREFIGHTER_BORDER = '#c2502f';
const FIREFIGHTER_BORDER_ACTIVE = '#ff8f6b';
const FIREFIGHTER_BG = '#2a1c17';

interface ScriptStep {
  at: number;
  run: (system: ConsoleSystem) => void;
}

const CYCLE_LENGTH = 30;

const SCRIPT: ScriptStep[] = [
  {
    at: 0,
    run: (s) => {
      s.resetRoster();
      s.resetFloors();
      s.addParticipant('caller', 'Caller - Floor 7 Break Rm', 'reporting smoke');
      s.reportFloor(6, 0, 0.5);
    },
  },
  {
    at: 4,
    run: (s) => {
      s.addParticipant('caller', 'Caller - Floor 7 Hallway', 'coughing heard');
      s.reportFloor(6, 0.35, 0.2);
    },
  },
  {
    at: 8,
    run: (s) => {
      s.addParticipant('firefighter', 'Engine 3', 'dispatched');
    },
  },
  {
    at: 11,
    run: (s) => {
      s.updateParticipantStatus('Engine 3', 'en route');
    },
  },
  {
    at: 16,
    run: (s) => {
      s.updateParticipantStatus('Engine 3', 'on scene');
    },
  },
  {
    at: 20,
    run: (s) => {
      s.addParticipant('caller', 'Caller - Floor 9', 'smoke in stairwell');
      s.reportFloor(8, 0, 0.4);
    },
  },
  {
    at: 24,
    run: (s) => {
      s.addParticipant('firefighter', 'Ladder 1', 'dispatched');
    },
  },
  {
    at: 27,
    run: (s) => {
      s.updateParticipantStatus('Ladder 1', 'en route');
    },
  },
];

/**
 * Owns the voice/comms panel roster and the resources panel stats. Drives a
 * looping scripted demo (callers reporting on specific floors, firefighters
 * progressing dispatched -> en route -> on scene) so the full data pipeline
 * is visible before real Photon/agent data exists. A later integration swaps
 * this script for real incident-state events over the WebSocket; the panel
 * rendering and slot/stat wiring below stays the same either way.
 */
export class ConsoleSystem extends createSystem({
  floors: { required: [FloorState] },
}) {
  private roster: (Participant | null)[] = new Array(MAX_SLOTS).fill(null);
  private elapsed = 0;
  private scriptIndex = 0;
  private speakingSlot = -1;
  private speakingElapsed = 0;

  private voicePanel: UIKitMLAsset | null = null;
  private resourcesPanel: UIKitMLAsset | null = null;
  private slotRoots: ReturnType<UIKitMLAsset['getElementById']>[] = [];
  private slotLabels: ReturnType<UIKitMLAsset['getElementById']>[] = [];
  private slotStatuses: ReturnType<UIKitMLAsset['getElementById']>[] = [];

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

    this.runScriptStep(0);
    this.renderVoicePanel();
    this.renderResourcesPanel();
  }

  update(delta: number): void {
    this.elapsed += delta;
    if (this.elapsed >= CYCLE_LENGTH) {
      this.elapsed -= CYCLE_LENGTH;
      this.scriptIndex = 0;
    }
    while (
      this.scriptIndex < SCRIPT.length &&
      this.elapsed >= SCRIPT[this.scriptIndex].at
    ) {
      this.runScriptStep(this.scriptIndex);
      this.scriptIndex++;
    }

    this.speakingElapsed += delta;
    if (this.speakingElapsed >= 1.4) {
      this.speakingElapsed = 0;
      this.advanceSpeaker();
      this.renderVoicePanel();
    }
  }

  private runScriptStep(index: number): void {
    const step = SCRIPT[index];
    if (step == null) {
      return;
    }
    step.run(this);
    this.renderVoicePanel();
    this.renderResourcesPanel();
  }

  resetRoster(): void {
    this.roster.fill(null);
    this.speakingSlot = -1;
  }

  addParticipant(kind: ParticipantKind, label: string, status: string): void {
    const freeSlot = this.roster.findIndex((entry) => entry == null);
    if (freeSlot === -1) {
      return;
    }
    this.roster[freeSlot] = { kind, label, status, speaking: false };
  }

  updateParticipantStatus(label: string, status: string): void {
    const participant = this.roster.find((entry) => entry?.label === label);
    if (participant == null) {
      return;
    }
    participant.status = status;
  }

  resetFloors(): void {
    for (const entity of this.queries.floors.entities) {
      entity.setValue(FloorState, 'fireLevel', 0);
      entity.setValue(FloorState, 'smokeLevel', 0);
    }
  }

  reportFloor(floorIndex: number, fireDelta: number, smokeDelta: number): void {
    const entity = [...this.queries.floors.entities].find(
      (candidate) =>
        (candidate.getValue(FloorState, 'floorIndex') ?? -1) === floorIndex,
    );
    if (entity == null) {
      return;
    }
    const fire = entity.getValue(FloorState, 'fireLevel') ?? 0;
    const smoke = entity.getValue(FloorState, 'smokeLevel') ?? 0;
    entity.setValue(FloorState, 'fireLevel', Math.min(1, fire + fireDelta));
    entity.setValue(FloorState, 'smokeLevel', Math.min(1, smoke + smokeDelta));
  }

  private advanceSpeaker(): void {
    const occupiedSlots: number[] = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (this.roster[i] != null) {
        occupiedSlots.push(i);
      }
    }
    if (occupiedSlots.length === 0) {
      this.speakingSlot = -1;
      return;
    }
    const currentPosition = occupiedSlots.indexOf(this.speakingSlot);
    const nextPosition = (currentPosition + 1) % occupiedSlots.length;
    this.speakingSlot = occupiedSlots[nextPosition];
  }

  private renderVoicePanel(): void {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const root = this.slotRoots[i];
      const label = this.slotLabels[i];
      const status = this.slotStatuses[i];
      const participant = this.roster[i];

      if (participant == null) {
        root?.setProperties({ display: 'none' });
        continue;
      }

      const speaking = i === this.speakingSlot;
      const isFirefighter = participant.kind === 'firefighter';
      const borderColor = isFirefighter
        ? speaking
          ? FIREFIGHTER_BORDER_ACTIVE
          : FIREFIGHTER_BORDER
        : speaking
          ? CALLER_BORDER_SPEAKING
          : CALLER_BORDER;

      root?.setProperties({
        display: 'flex',
        borderColor,
        backgroundColor: isFirefighter ? FIREFIGHTER_BG : CALLER_BG,
      });
      label?.setProperties({ text: participant.label });
      status?.setProperties({
        text: speaking ? `${participant.status} - speaking` : participant.status,
      });
    }
  }

  private renderResourcesPanel(): void {
    let dispatched = 0;
    let enRoute = 0;
    let onScene = 0;
    for (const participant of this.roster) {
      if (participant?.kind !== 'firefighter') {
        continue;
      }
      if (participant.status === 'dispatched') {
        dispatched++;
      } else if (participant.status === 'en route') {
        enRoute++;
      } else if (participant.status === 'on scene') {
        onScene++;
      }
    }

    let atRiskFloors = 0;
    for (const entity of this.queries.floors.entities) {
      const fire = entity.getValue(FloorState, 'fireLevel') ?? 0;
      const smoke = entity.getValue(FloorState, 'smokeLevel') ?? 0;
      if (fire > AT_RISK_THRESHOLD || smoke > AT_RISK_THRESHOLD) {
        atRiskFloors++;
      }
    }

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
      ?.setProperties({ text: String(atRiskFloors * PEOPLE_PER_AT_RISK_FLOOR) });
  }
}
