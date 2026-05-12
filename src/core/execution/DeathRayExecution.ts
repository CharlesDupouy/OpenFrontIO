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

export class DeathRayExecution implements Execution {
  private active = true;
  private mg: Game;
  private nuke: Unit | null = null;
  private pathFinder: ParabolaUniversalPathFinder;
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
      const spawn = this.player.canBuild(UnitType.DeathRay, this.dst);
      if (spawn === false) {
        console.warn(`cannot build DeathRay`);
        this.active = false;
        return;
      }
      this.src = spawn;
      this.nuke = this.player.buildUnit(UnitType.DeathRay, spawn, {
        targetTile: this.dst,
        trajectory: this.getTrajectory(this.dst),
      });

      if (this.mg.hasOwner(this.dst)) {
        const targetOwner = this.mg.owner(this.dst);
        if (targetOwner.isPlayer()) {
          this.mg.displayIncomingUnit(
            this.nuke.id(),
            `${this.player.displayName()} - death ray inbound`,
            MessageType.DEATH_RAY_INBOUND,
            targetOwner.id(),
          );
        }
      }

      this.mg
        .stats()
        .bombLaunch(this.player, this.target(), UnitType.DeathRay);

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

    const result = this.pathFinder.next(this.src!, this.dst, this.speed);
    if (result.status === PathStatus.COMPLETE) {
      this.detonate();
    } else if (result.status === PathStatus.NEXT) {
      this.updateTargetable();
      this.nuke.move(result.node);
      this.nuke.setTrajectoryIndex(this.pathFinder.currentIndex());
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

  private detonate() {
    if (this.nuke === null) throw new Error("Not initialized");
    const mg = this.mg;

    const targetOwner = mg.owner(this.dst);
    if (targetOwner.isPlayer()) {
      // Flood-fill the player's connected territory from the impact point
      const connected = mg.bfs(this.dst, (_, n: TileRef) => {
        return mg.owner(n) === targetOwner;
      });

      const totalTiles = targetOwner.numTilesOwned();
      const numConnected = connected.size;

      // Destroy all connected tiles
      for (const tile of connected) {
        targetOwner.relinquish(tile);
        if (mg.isLand(tile)) {
          mg.queueWaterConversion(tile);
        }
      }

      // Kill troops proportional to territory fraction destroyed
      const fraction = numConnected / Math.max(1, totalTiles);
      targetOwner.removeTroops(
        Math.floor(targetOwner.troops() * fraction),
      );
      for (const attack of targetOwner.outgoingAttacks()) {
        attack.setTroops(Math.floor(attack.troops() * (1 - fraction)));
      }
      for (const ship of targetOwner.units(UnitType.TransportShip)) {
        ship.setTroops(Math.floor(ship.troops() * (1 - fraction)));
      }

      // Break alliance with the target player
      const alliance = this.player.allianceWith(targetOwner);
      if (alliance !== null) {
        this.player.breakAlliance(alliance);
      }
      targetOwner.updateRelation(this.player, -100);

      // Destroy all structures and units on the connected territory
      const destroyer = this.player;
      for (const unit of mg.units()) {
        const type = unit.type();
        if (
          type === UnitType.AtomBomb ||
          type === UnitType.HydrogenBomb ||
          type === UnitType.FaultyBomb ||
          type === UnitType.DeathRay ||
          type === UnitType.MIRVWarhead ||
          type === UnitType.MIRV ||
          type === UnitType.SAMMissile
        ) {
          continue;
        }
        if (connected.has(unit.tile())) {
          if (type === UnitType.Godzilla) {
            if (unit.reachedTarget()) {
              unit.modifyHealth(-1, destroyer);
            }
          } else {
            unit.delete(true, destroyer);
          }
        }
      }

      // Redraw nearby structures at impact for visual cleanup
      const redrawRange =
        mg.config().nukeMagnitudes(UnitType.DeathRay).outer + 16;
      const redrawRangeSquared = redrawRange * redrawRange;
      for (const unit of mg.units()) {
        if (
          Structures.has(unit.type()) &&
          mg.euclideanDistSquared(this.dst, unit.tile()) < redrawRangeSquared
        ) {
          unit.touch();
        }
      }
    }

    this.active = false;
    this.nuke.setReachedTarget();
    this.nuke.delete(false);

    mg
      .stats()
      .bombLand(this.player, this.target(), UnitType.DeathRay);
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
