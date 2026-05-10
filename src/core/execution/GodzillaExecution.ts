import {
  Execution,
  Game,
  MessageType,
  Player,
  Structures,
  TrajectoryTile,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { UniversalPathFinding } from "../pathfinding/PathFinder";
import { ParabolaUniversalPathFinder } from "../pathfinding/PathFinder.Parabola";
import { PathStatus } from "../pathfinding/types";
import { PseudoRandom } from "../PseudoRandom";

const FALLOUT_RADIUS = 5;
const ATTACK_RADIUS = 3;
const TICKS_PER_MOVE = 1;
const STRUCTURE_SEARCH_RADIUS = 50;

export class GodzillaExecution implements Execution {
  private active = true;
  private mg!: Game;
  private godzilla: Unit | null = null;
  private pathFinder!: ParabolaUniversalPathFinder;
  private landed = false;
  private ticksSinceLanding = 0;
  private random!: PseudoRandom;

  constructor(
    private player: Player,
    private dst: TileRef,
    private src: TileRef | null = null,
    private speed: number = -1,
    private rocketDirectionUp: boolean = true,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(ticks);
    if (this.speed === -1) {
      this.speed = this.mg.config().defaultNukeSpeed();
    }
    this.pathFinder = UniversalPathFinding.Parabola(mg, {
      increment: this.speed,
      distanceBasedHeight: true,
      directionUp: this.rocketDirectionUp,
    });
  }

  tick(ticks: number): void {
    if (!this.landed) {
      this.tickFlight(ticks);
    } else {
      this.tickGround(ticks);
    }
  }

  private tickFlight(_ticks: number): void {
    if (this.godzilla === null) {
      const spawn = this.player.canBuild(UnitType.Godzilla, this.dst);
      if (spawn === false) {
        console.warn("cannot build Godzilla");
        this.active = false;
        return;
      }
      this.src = spawn;
      this.godzilla = this.player.buildUnit(UnitType.Godzilla, spawn, {
        targetTile: this.dst,
        trajectory: this.getTrajectory(this.dst),
      });

      if (this.mg.hasOwner(this.dst)) {
        const target = this.mg.owner(this.dst);
        if (target.isPlayer()) {
          this.mg.displayIncomingUnit(
            this.godzilla.id(),
            `${this.player.displayName()} - Godzilla inbound`,
            MessageType.GODZILLA_INBOUND,
            target.id(),
          );
        }
      }

      const silo = this.player
        .units(UnitType.MissileSilo)
        .find((s) => s.tile() === spawn);
      if (silo) {
        silo.launch();
      }
      return;
    }

    // SAM intercepted it
    if (!this.godzilla.isActive()) {
      this.active = false;
      return;
    }

    const result = this.pathFinder.next(this.src!, this.dst, this.speed);
    if (result.status === PathStatus.COMPLETE) {
      this.land();
    } else if (result.status === PathStatus.NEXT) {
      this.updateTargetable();
      this.godzilla.move(result.node);
      this.godzilla.setTrajectoryIndex(this.pathFinder.currentIndex());
    }
  }

  private land(): void {
    if (this.godzilla === null) return;
    this.godzilla.move(this.dst);
    this.godzilla.setReachedTarget();
    this.landed = true;
    this.ticksSinceLanding = 0;
    this.leaveFallout(this.dst);
    this.attackStructures();
  }

  private tickGround(_ticks: number): void {
    if (this.godzilla === null || !this.godzilla.isActive()) {
      this.active = false;
      return;
    }

    this.ticksSinceLanding++;
    this.leaveFallout(this.godzilla.tile());
    this.attackStructures();

    if (this.ticksSinceLanding % TICKS_PER_MOVE === 0) {
      this.moveOnGround();
    }
  }

  private moveOnGround(): void {
    if (this.godzilla === null) return;

    const currentTile = this.godzilla.tile();
    const target = this.findNearestStructure();

    const landNeighbors: TileRef[] = [];
    this.mg.forEachNeighbor(currentTile, (neighbor) => {
      if (this.mg.isLand(neighbor)) {
        landNeighbors.push(neighbor);
      }
    });

    if (landNeighbors.length === 0) return;

    let nextTile: TileRef;
    if (target !== null) {
      // Always greedy: step toward nearest structure
      let bestDist = Infinity;
      let bestTile = landNeighbors[0];
      for (const neighbor of landNeighbors) {
        const dist = this.mg.manhattanDist(neighbor, target);
        if (dist < bestDist) {
          bestDist = dist;
          bestTile = neighbor;
        }
      }
      nextTile = bestTile;
    } else {
      // No target in search radius: pick a random neighbor
      nextTile = this.random.randElement(landNeighbors);
    }

    this.godzilla.move(nextTile);
  }

  private findNearestStructure(): TileRef | null {
    const nearby = this.mg.nearbyUnits(
      this.godzilla!.tile(),
      STRUCTURE_SEARCH_RADIUS,
      Structures.types,
    );
    return nearby.length > 0 ? nearby[0].unit.tile() : null;
  }

  private attackStructures(): void {
    if (this.godzilla === null) return;
    const nearby = this.mg.nearbyUnits(
      this.godzilla.tile(),
      ATTACK_RADIUS,
      Structures.types,
    );
    for (const { unit } of nearby) {
      unit.delete(true, this.player);
    }
  }

  private leaveFallout(center: TileRef): void {
    const cx = this.mg.x(center);
    const cy = this.mg.y(center);
    const r2 = FALLOUT_RADIUS * FALLOUT_RADIUS;

    for (let dy = -FALLOUT_RADIUS; dy <= FALLOUT_RADIUS; dy++) {
      for (let dx = -FALLOUT_RADIUS; dx <= FALLOUT_RADIUS; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.mg.width() || ny >= this.mg.height())
          continue;
        const tile = this.mg.ref(nx, ny);
        if (!this.mg.isLand(tile)) continue;
        if (this.mg.hasOwner(tile)) {
          this.mg.relinquish(tile);
        }
        this.mg.setFallout(tile, true);
      }
    }
  }

  private getTrajectory(target: TileRef): TrajectoryTile[] {
    const targetRangeSquared =
      this.mg.config().defaultNukeTargetableRange() ** 2;
    const allTiles = this.pathFinder.findPath(this.src!, target) ?? [];
    return allTiles.map((tile) => ({
      tile,
      targetable:
        this.mg.euclideanDistSquared(tile, target) < targetRangeSquared ||
        (this.src !== null &&
          this.mg.euclideanDistSquared(this.src, tile) < targetRangeSquared),
    }));
  }

  private updateTargetable(): void {
    if (this.godzilla === null || this.godzilla.targetTile() === undefined)
      return;
    const targetRangeSquared =
      this.mg.config().defaultNukeTargetableRange() ** 2;
    const targetTile = this.godzilla.targetTile()!;
    this.godzilla.setTargetable(
      this.mg.euclideanDistSquared(targetTile, this.godzilla.tile()) <
        targetRangeSquared ||
        (this.src !== null &&
          this.mg.euclideanDistSquared(this.src, this.godzilla.tile()) <
            targetRangeSquared),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}
