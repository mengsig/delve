import terrainUrl from './design/terrain.svg';

export function Terrain() {
  return <img className="topo" src={terrainUrl} alt="" draggable={false} />;
}
