export interface BackupFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly checksum: string;
}

export interface BackupTarget {
  readonly kind: "none" | "s3" | "sftp";
  // Resolve only once the complete file is published at its supplied name.
  upload(file: BackupFile): Promise<void>;
}
