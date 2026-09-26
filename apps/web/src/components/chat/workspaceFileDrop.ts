export interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    readonly items?: Iterable<{
      readonly kind: string;
      getAsFile(): File | null;
      webkitGetAsEntry?(): { readonly isDirectory: boolean; readonly name?: string } | null;
    }>;
    dropEffect: string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

export interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
  addFolders(folders: File[], unresolvedCount: number): void;
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

function splitDroppedItems(dataTransfer: WorkspaceFileDragEvent["dataTransfer"]): {
  files: File[];
  folders: File[];
  unresolvedFolders: number;
} {
  if (dataTransfer.items === undefined)
    return { files: Array.from(dataTransfer.files), folders: [], unresolvedFolders: 0 };

  const files: File[] = [];
  const folders: File[] = [];
  let unresolvedFolders = 0;
  let unresolvedUnnamedFolders = 0;
  const unresolvedNames = new Set<string>();
  const seen = new Map<string, number>();
  const fileKey = (file: File) =>
    JSON.stringify([file.name, file.size, file.lastModified, file.type]);
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    const file = item.getAsFile();
    if (file === null) {
      if (entry?.isDirectory) {
        unresolvedFolders += 1;
        if (entry.name) unresolvedNames.add(entry.name);
        else unresolvedUnnamedFolders += 1;
      }
      continue;
    }
    const key = fileKey(file);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (entry?.isDirectory === true) {
      folders.push(file);
    } else {
      files.push(file);
    }
  }
  // Some browsers expose a FileList entry while an item cannot return its File object. Keep
  // those ordinary attachments instead of silently dropping them. Counts avoid duplicating
  // already classified files, including distinct files with the same name and size.
  for (const file of dataTransfer.files) {
    const key = fileKey(file);
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      seen.set(key, count - 1);
      continue;
    }
    // A FileList placeholder and a distinct empty file can be indistinguishable when both
    // drag items return null. Exclude all ambiguous candidates and report the failed drop.
    if (unresolvedNames.has(file.name) && file.size === 0 && file.type === "") continue;
    if (unresolvedUnnamedFolders > 0 && file.size === 0 && file.type === "") {
      continue;
    }
    files.push(file);
  }
  return { files, folders, unresolvedFolders };
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      host.setDragActive(false);
      const { files, folders, unresolvedFolders } = splitDroppedItems(event.dataTransfer);
      if (files.length > 0) host.addFiles(files);
      if (folders.length > 0 || unresolvedFolders > 0) host.addFolders(folders, unresolvedFolders);
    },
  };
}
