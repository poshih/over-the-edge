import { Group } from 'three';
import type { EnemyArtSettings } from './enemy-art-data';
import { ENEMY_SPECIES } from './enemy-types';
import type { EnemyEvent, EnemyPose, EnemySpecies } from './enemy-types';
import { EnemyView } from './enemy-view';
import type { EnemyLook, EnemyModelLook, EnemyModelLookFactory } from './object-looks';

type MutableEnemyPose = { -readonly [K in keyof EnemyPose]: EnemyPose[K] };

/**
 * The engine's enemy look: each species whose art is a 3D model as that model once it has loaded, through the engine's
 * enemy-model look, and the rest as pixel art. A model's species shows its built-in pixel art while its GLB loads, when
 * it cannot load, and in a game that draws no enemy models.
 */
export class EngineEnemyLook implements EnemyLook {
  readonly root = new Group();
  readonly passes = { actors: this.root };
  private readonly sprites: EnemyView;
  private readonly models: EnemyModelLook | null;
  private readonly unsubscribe: () => void;
  // Every enemy as its events last told, so a species moving between the sprites and the models takes them along.
  private readonly members = new Map<string, MutableEnemyPose>();
  // The species the models draw now, which the sprites skip.
  private readonly modelled = new Set<EnemySpecies>();

  constructor(art: EnemyArtSettings, models: EnemyModelLookFactory | null) {
    this.root.name = 'enemy-look';
    this.sprites = new EnemyView(art, this.modelled);
    try {
      this.models = models === null ? null : models(art);
    } catch (error) {
      this.sprites.dispose();
      throw error;
    }
    this.root.add(this.sprites.root);
    if (this.models !== null) this.root.add(this.models.root);
    this.unsubscribe = this.models === null ? () => {} : this.models.subscribe(() => this.route());
    this.route();
  }

  apply(event: EnemyEvent): void {
    switch (event.type) {
      case 'reset':
        this.members.clear();
        for (const pose of event.poses) this.members.set(pose.id, { ...pose });
        this.sprites.apply({ type: 'reset', poses: event.poses.filter((pose) => !this.modelled.has(pose.species)) });
        break;
      case 'upsert': {
        const member = this.members.get(event.pose.id);
        if (member === undefined) this.members.set(event.pose.id, { ...event.pose });
        else Object.assign(member, event.pose);
        if (!this.modelled.has(event.pose.species)) this.sprites.apply(event);
        break;
      }
      case 'remove':
        this.members.delete(event.id);
        this.sprites.apply(event);
        break;
    }
  }

  // Each draws the poses of its own species.
  update(poses: readonly EnemyPose[], time: number): void {
    this.sprites.update(poses, time);
    this.models?.update(poses, time);
  }

  setArt(art: EnemyArtSettings): void {
    this.sprites.setArt(art);
    this.models?.setArt(art);
    this.route();
  }

  dispose(): void {
    this.unsubscribe();
    this.sprites.dispose();
    this.models?.dispose();
    this.members.clear();
    this.root.removeFromParent();
  }

  inspect() {
    return { sprites: this.sprites.inspect(), models: this.models?.inspect() ?? null, modelled: [...this.modelled] };
  }

  // Hands each species to the models once its model draws, and back to the sprites when it no longer does.
  private route(): void {
    for (const species of ENEMY_SPECIES) {
      const modelled = this.models?.draws(species) ?? false;
      if (modelled === this.modelled.has(species)) continue;
      if (modelled) this.modelled.add(species);
      else this.modelled.delete(species);
      for (const member of this.members.values()) {
        if (member.species !== species) continue;
        this.sprites.apply(modelled ? { type: 'remove', id: member.id } : { type: 'upsert', pose: member });
      }
    }
  }
}
