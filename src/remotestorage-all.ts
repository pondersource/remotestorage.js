import RemoteStorageWithSolid from './remotestorage-solid';
import LWS from './lws';
import OneDrive from './onedrive';
import NextGraph from './nextgraph';
import Atomic from './atomic';

/** Ponder Source distribution with every implemented backend. */
export class RemoteStorageWithAllBackends extends RemoteStorageWithSolid {
  static LWS = LWS;
  static OneDrive = OneDrive;
  static NextGraph = NextGraph;
  static Atomic = Atomic;
  static AtomicPlugin = true;
}

export default RemoteStorageWithAllBackends;
