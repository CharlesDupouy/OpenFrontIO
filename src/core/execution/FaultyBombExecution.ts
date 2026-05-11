import {
  Execution,
  Game,
  MessageType,
  Player,
  Structures,
  TerraNullius,
  TrajectoryTile,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { UniversalPathFinding } from "../pathfinding/PathFinder";
import { ParabolaUniversalPathFinder } from "../pathfinding/PathFinder.Parabola";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";
import { NukeType } from "../StatsSchemas";
import { listNukeBreakAlliance } from "./Util";

// 2% chance of misfire per tick — short shots are relatively safe, long shots are risky.
const MISFIRE_ODDS = 50;

const SPRITE_RADIUS = 16;

export class FaultyBombExecution implements Execution {
  private active = true;
  private mg: Game;
  private nuke: Unit | null = null;
  private pathFinder: ParabolaUniversalPathFinder;
  private rand: PseudoRandom;
  private speed: number = -1;

  constructor(
    private player: Player,
    private dst: TileRef,
    private src: TileRef | null = null,
    private rocketDirectionUp: boolean = true,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.speed = mg.config().defaultNukeSpeed();
    // Seed with launch tick + dst for determinism across clients
    this.rand = new PseudoRandom(ticks ^ (this.dst * 7919));
    this.pathFinder = UniversalPathFinding.Parabola(mg, {
      increment: this.speed,
      distanceBasedHeight: true,
      directionUp: this.rocketDirectionUp,
    });
  }

  public target(): Player | TerraNullius {
    return this.mg.owner(this.dst);
  }

  tick(ticks: number): void {
    if (this.nuke === null) {
      const spawn = this.player.canBuild(UnitType.FaultyBomb, this.dst);
      if (spawn === false) {
        console.warn(`cannot build FaultyBomb`);
        this.active = false;
        return;
      }
      this.src = spawn;
      this.nuke = this.player.buildUnit(UnitType.FaultyBomb, spawn, {
        targetTile: this.dst,
        trajectory: this.getTrajectory(this.dst),
      });

      this.maybeBreakAlliances();

      if (this.mg.hasOwner(this.dst)) {
        const targetOwner = this.mg.owner(this.dst);
        if (targetOwner.isPlayer()) {
          this.mg.displayIncomingUnit(
            this.nuke.id(),
            `${this.player.displayName()} - faulty bomb inbound`,
            MessageType.FAULTY_BOMB_INBOUND,
            targetOwner.id(),
          );
        }
      }

      this.mg.stats().bombLaunch(this.player, this.target(), UnitType.FaultyBomb);

      const silo = this.player
        .units(UnitType.MissileSilo)
        .find((s) => s.tile() === spawn);
      if (silo) {
        silo.launch();
      }
      return;
    }

    if (!this.nuke.isActive()) {
      this.active = false;
      return;
    }

    // Move first so the nuke's tile reflects its current position before misfire check
    const result = this.pathFinder.next(this.src!, this.dst, this.speed);
    if (result.status === PathStatus.NEXT) {
      this.updateTargetable();
      this.nuke.move(result.node);
      this.nuke.setTrajectoryIndex(this.pathFinder.currentIndex());
    }

    // Check for misfire at current position (after moving)
    if (this.rand.chance(MISFIRE_ODDS)) {
      this.dst = this.nuke.tile();
      this.detonate();
      return;
    }

    if (result.status === PathStatus.COMPLETE) {
      this.detonate();
    }
  }

  public getNuke(): Unit | null {
    return this.nuke;
  }

  private getTrajectory(target: TileRef): TrajectoryTile[] {
    const targetRangeSquared =
      this.mg.config().defaultNukeTargetableRange() ** 2;
    const allTiles = this.pathFinder.findPath(this.src!, target) ?? [];
    return allTiles.map((tile) => ({
      tile,
      targetable: this.isTargetable(target, tile, targetRangeSquared),
    }));
  }

  private isTargetable(
    targetTile: TileRef,
    nukeTile: TileRef,
    targetRangeSquared: number,
  ): boolean {
    return (
      this.mg.euclideanDistSquared(nukeTile, targetTile) < targetRangeSquared ||
      (this.src !== null &&
        this.mg.euclideanDistSquared(this.src, nukeTile) < targetRangeSquared)
    );
  }

  private updateTargetable() {
    if (this.nuke === null || this.nuke.targetTile() === undefined) return;
    const targetRangeSquared =
      this.mg.config().defaultNukeTargetableRange() ** 2;
    const targetTile = this.nuke.targetTile();
    this.nuke.setTargetable(
      this.isTargetable(targetTile!, this.nuke.tile(), targetRangeSquared),
    );
  }

  private maybeBreakAlliances() {
    if (this.nuke === null) return;
    const magnitude = this.mg.config().nukeMagnitudes(UnitType.FaultyBomb);
    const playersToBreak = listNukeBreakAlliance({
      game: this.mg,
      targetTile: this.dst,
      magnitude,
      threshold: this.mg.config().nukeAllianceBreakThreshold(),
    });

    for (const incoming of this.player.incomingAllianceRequests()) {
      if (playersToBreak.has(incoming.requestor().smallID())) {
        incoming.reject();
      }
    }

    for (const playerSmallId of playersToBreak) {
      const attacked = this.mg.playerBySmallID(playerSmallId);
      if (!attacked.isPlayer()) continue;

      const outgoing = attacked
        .incomingAllianceRequests()
        .find((ar) => ar.requestor() === this.player);
      if (outgoing) {
        outgoing.reject();
        continue;
      }

      const alliance = this.player.allianceWith(attacked);
      if (alliance !== null) {
        this.player.breakAlliance(alliance);
      }
      if (attacked !== this.player) {
        attacked.updateRelation(this.player, -100);
      }
    }
  }

  private detonate() {
    if (this.nuke === null) throw new Error("Not initialized");

    const mg = this.mg;
    const magnitude = mg.config().nukeMagnitudes(UnitType.FaultyBomb);
    const rand = new PseudoRandom(mg.ticks());
    const inner2 = magnitude.inner * magnitude.inner;
    const outer2 = magnitude.outer * magnitude.outer;

    let toDestroy: Set<TileRef>;
    if (mg.config().waterNukes()) {
      const NUM_SAMPLES = 16;
      const radiiSq: number[] = new Array(NUM_SAMPLES);
      for (let i = 0; i < NUM_SAMPLES; i++) {
        radiiSq[i] = rand.nextFloat(inner2, outer2);
      }
      const prev = [...radiiSq];
      for (let i = 0; i < NUM_SAMPLES; i++) {
        const l = (i - 1 + NUM_SAMPLES) % NUM_SAMPLES;
        const r = (i + 1) % NUM_SAMPLES;
        radiiSq[i] = prev[i] * 0.6 + prev[l] * 0.2 + prev[r] * 0.2;
      }
      const cx = mg.x(this.dst);
      const cy = mg.y(this.dst);
      const outer = magnitude.outer;
      toDestroy = new Set<TileRef>();
      const x0 = Math.max(0, cx - outer);
      const y0 = Math.max(0, cy - outer);
      const x1 = Math.min(mg.width() - 1, cx + outer);
      const y1 = Math.min(mg.height() - 1, cy + outer);
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const dx = px - cx;
          const dy = py - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 > outer2) continue;
          if (d2 > inner2) {
            const angle = Math.atan2(dy, dx) + Math.PI;
            const t = (angle / (2 * Math.PI)) * NUM_SAMPLES;
            const i0 = Math.floor(t) % NUM_SAMPLES;
            const i1 = (i0 + 1) % NUM_SAMPLES;
            const frac = t - Math.floor(t);
            const threshold = radiiSq[i0] * (1 - frac) + radiiSq[i1] * frac;
            if (d2 > threshold) continue;
          }
          toDestroy.add(mg.ref(px, py));
        }
      }
    } else {
      toDestroy = mg.bfs(this.dst, (_, n: TileRef) => {
        const d2 = mg.euclideanDistSquared(this.dst, n);
        return d2 <= outer2 && (d2 <= inner2 || rand.chance(2));
      });
    }

    const tilesPerPlayer = new Map<Player, number>();
    for (const tile of toDestroy) {
      const owner = mg.owner(tile);
      if (owner.isPlayer()) {
        owner.relinquish(tile);
        tilesPerPlayer.set(owner, (tilesPerPlayer.get(owner) ?? 0) + 1);
      }
      if (mg.isLand(tile)) {
        mg.queueWaterConversion(tile);
      }
    }

    const config = mg.config();
    for (const [player, numImpacted] of tilesPerPlayer) {
      const tilesBefore = player.numTilesOwned() + numImpacted;
      const transportShips = player.units(UnitType.TransportShip);
      const outgoingAttacks = player.outgoingAttacks();
      const maxTroops = config.maxTroops(player);
      for (let i = 0; i < numImpacted; i++) {
        const numTilesLeft = tilesBefore - i;
        player.removeTroops(
          config.nukeDeathFactor(
            UnitType.FaultyBomb,
            player.troops(),
            numTilesLeft,
            maxTroops,
          ),
        );
        for (const attack of outgoingAttacks) {
          const attackTroops = attack.troops();
          attack.setTroops(
            attackTroops -
              config.nukeDeathFactor(
                UnitType.FaultyBomb,
                attackTroops,
                numTilesLeft,
                maxTroops,
              ),
          );
        }
        for (const unit of transportShips) {
          const unitTroops = unit.troops();
          unit.setTroops(
            unitTroops -
              config.nukeDeathFactor(
                UnitType.FaultyBomb,
                unitTroops,
                numTilesLeft,
                maxTroops,
              ),
          );
        }
      }
    }

    const destroyer = this.player;
    for (const unit of mg.units()) {
      const type = unit.type();
      if (
        type === UnitType.AtomBomb ||
        type === UnitType.HydrogenBomb ||
        type === UnitType.FaultyBomb ||
        type === UnitType.MIRVWarhead ||
        type === UnitType.MIRV ||
        type === UnitType.SAMMissile
      ) {
        continue;
      }
      if (mg.euclideanDistSquared(this.dst, unit.tile()) < outer2) {
        if (type === UnitType.Godzilla) {
          if (unit.reachedTarget()) {
            unit.modifyHealth(-1, destroyer);
          }
        } else {
          unit.delete(true, destroyer);
        }
      }
    }

    // Redraw nearby buildings
    const redrawRange = magnitude.outer + SPRITE_RADIUS;
    const redrawRangeSquared = redrawRange * redrawRange;
    for (const unit of mg.units()) {
      if (
        Structures.has(unit.type()) &&
        mg.euclideanDistSquared(this.dst, unit.tile()) < redrawRangeSquared
      ) {
        unit.touch();
      }
    }

    this.active = false;
    this.nuke.setReachedTarget();
    this.nuke.delete(false);

    mg.stats().bombLand(this.player, this.target(), UnitType.FaultyBomb as NukeType);
  }

  owner(): Player {
    return this.player;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
