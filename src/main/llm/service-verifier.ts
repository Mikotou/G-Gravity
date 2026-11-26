export class ServiceVerifier<T> {
  private active?: T;
  private proof?: { settings: T; verifiedAt: string };

  constructor(private same: (left: T, right: T) => boolean) {}

  begin(candidate: T): void { this.active = candidate; }
  current(candidate: T): boolean { return this.active === candidate; }
  finish(candidate: T): void { if (this.current(candidate)) this.active = undefined; }

  verifiedAt(settings: T): string | undefined {
    return this.proof && this.same(this.proof.settings, settings) ? this.proof.verifiedAt : undefined;
  }
  accept(settings: T): string {
    const verifiedAt = new Date().toISOString();
    this.proof = { settings, verifiedAt };
    return verifiedAt;
  }
  reject(): void { this.proof = undefined; }
  changed(settings: T, invalidate: boolean): void {
    if (this.active && (invalidate || !this.same(this.active, settings))) this.active = undefined;
    if (this.proof && !this.same(this.proof.settings, settings)) this.proof = undefined;
  }
}
