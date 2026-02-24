import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatSelectModule } from '@angular/material/select';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

type ItemType = 'essen' | 'getränk';

interface Item {
  id: string;
  name: string;
  item_type: ItemType;
  quantity: number | null;
  unit: string | null;
  ean?: string | null;
}

interface EanLookupResult {
  ean: string;
  known: boolean;
  item: Item | null;
}

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatSnackBarModule,
    MatSelectModule,
  ],
  templateUrl: './inventory.html',
  styleUrl: './inventory.css',
})
export class Inventory implements OnInit, OnDestroy {
  private static zxingLoadPromise: Promise<any> | null = null;

  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  @ViewChild('inventoryVideo') inventoryVideo?: ElementRef<HTMLVideoElement>;

  private zxingNamespace: any = null;
  private zxingReader: any = null;
  private zxingControls: { stop: () => void } | null = null;

  loading = signal(true);
  scannerSupported = signal(
    typeof window !== 'undefined' &&
      !!navigator.mediaDevices &&
      !!navigator.mediaDevices.getUserMedia
  );
  scannerLoading = signal(false);
  scannerActive = signal(false);

  items = signal<Item[]>([]);
  search = signal('');

  eanInput = signal('');
  scanItem = signal<Item | null>(null);
  scanDelta = signal(1);

  rowDeltas = signal<Record<string, number>>({});

  ngOnInit(): void {
    this.reloadItems();
  }

  ngOnDestroy(): void {
    this.stopScanner();
  }

  visibleItems(): Item[] {
    const search = this.search().trim().toLowerCase();
    if (!search) return this.items();

    return this.items().filter((item) => {
      return (
        item.name.toLowerCase().includes(search) ||
        item.item_type.toLowerCase().includes(search) ||
        (item.ean || '').toLowerCase().includes(search)
      );
    });
  }

  reloadItems(): void {
    this.loading.set(true);
    this.api.get('/api/items/?include_images=false', this.auth.token()).subscribe((res: any) => {
      this.loading.set(false);
      if (this.isApiError(res)) {
        this.items.set([]);
        this.snackBar.open('Inventur-Liste konnte nicht geladen werden.', 'OK', { duration: 2500 });
        return;
      }

      const list = (res as Item[]).sort((a, b) => a.name.localeCompare(b.name, 'de'));
      this.items.set(list);
    });
  }

  setSearch(value: string): void {
    this.search.set(value);
  }

  setEanInput(value: string): void {
    this.eanInput.set(value);
  }

  setScanDelta(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.scanDelta.set(1);
      return;
    }
    this.scanDelta.set(parsed);
  }

  setRowDelta(itemId: string, value: string): void {
    const parsed = Number(value);
    this.rowDeltas.update((current) => ({
      ...current,
      [itemId]: Number.isFinite(parsed) && parsed > 0 ? parsed : 1,
    }));
  }

  getRowDelta(itemId: string): number {
    const found = this.rowDeltas()[itemId];
    return Number.isFinite(found) && found > 0 ? found : 1;
  }

  lookupEan(): void {
    const ean = this.eanInput().trim();
    if (!ean) {
      this.snackBar.open('Bitte EAN eingeben oder scannen.', 'OK', { duration: 2200 });
      return;
    }

    this.api.get(`/api/items/ean/${encodeURIComponent(ean)}/lookup/`, this.auth.token()).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.scanItem.set(null);
        this.snackBar.open('EAN-Suche fehlgeschlagen.', 'OK', { duration: 2500 });
        return;
      }

      const lookup = res as EanLookupResult;
      if (!lookup.known || !lookup.item) {
        this.scanItem.set(null);
        this.snackBar.open('EAN unbekannt. Bitte Produkt zuerst anlegen.', 'OK', { duration: 2800 });
        return;
      }

      this.scanItem.set(lookup.item);
    });
  }

  applyScannedAdjust(direction: 'consume' | 'restock'): void {
    const item = this.scanItem();
    if (!item) return;

    const deltaBase = this.scanDelta();
    const delta = direction === 'consume' ? -deltaBase : deltaBase;
    this.adjustStock(item.id, delta, direction, true);
  }

  rowAdjust(item: Item, direction: 'consume' | 'restock'): void {
    const base = this.getRowDelta(item.id);
    const delta = direction === 'consume' ? -base : base;
    this.adjustStock(item.id, delta, direction, false);
  }

  async toggleScanner(): Promise<void> {
    if (this.scannerActive()) {
      this.stopScanner();
      return;
    }
    await this.startScanner();
  }

  private async startScanner(): Promise<void> {
    if (!this.scannerSupported()) {
      this.snackBar.open('Scanner wird im aktuellen Browser nicht unterstützt.', 'OK', { duration: 3000 });
      return;
    }

    try {
      this.scannerLoading.set(true);
      await this.ensureZxingLoaded();
      this.scannerLoading.set(false);
      this.scannerActive.set(true);
      await this.startZxingDecoding();
    } catch {
      this.scannerLoading.set(false);
      this.stopScanner();
      this.snackBar.open('Scanner konnte nicht gestartet werden.', 'OK', { duration: 3000 });
    }
  }

  private async ensureZxingLoaded(): Promise<void> {
    if (this.zxingNamespace) return;

    const win = window as any;
    if (win.ZXingBrowser) {
      this.zxingNamespace = win.ZXingBrowser;
      return;
    }

    if (!Inventory.zxingLoadPromise) {
      Inventory.zxingLoadPromise = new Promise((resolve, reject) => {
        const existing = document.getElementById('zxing-browser-script') as HTMLScriptElement | null;
        if (existing) {
          existing.addEventListener('load', () => resolve((window as any).ZXingBrowser));
          existing.addEventListener('error', () => reject(new Error('ZXing script load failed')));
          return;
        }

        const script = document.createElement('script');
        script.id = 'zxing-browser-script';
        script.src = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js';
        script.async = true;
        script.defer = true;
        script.onload = () => resolve((window as any).ZXingBrowser);
        script.onerror = () => reject(new Error('ZXing script load failed'));
        document.head.appendChild(script);
      });
    }

    try {
      this.zxingNamespace = await Inventory.zxingLoadPromise;
    } catch (error) {
      Inventory.zxingLoadPromise = null;
      throw error;
    }
  }

  private async startZxingDecoding(): Promise<void> {
    const video = this.inventoryVideo?.nativeElement;
    if (!video || !this.zxingNamespace) throw new Error('Video oder ZXing fehlt');

    this.zxingReader = new this.zxingNamespace.BrowserMultiFormatReader();

    const callback = (result: any) => {
      const value = this.extractScanText(result);
      if (!value) return;
      this.onCodeDetected(value);
    };

    if (typeof this.zxingReader.decodeFromConstraints === 'function') {
      this.zxingControls = await this.zxingReader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        video,
        callback
      );
      return;
    }

    if (typeof this.zxingReader.decodeFromVideoDevice === 'function') {
      this.zxingControls = await this.zxingReader.decodeFromVideoDevice(undefined, video, callback);
      return;
    }

    throw new Error('ZXing API nicht unterstützt');
  }

  private extractScanText(result: any): string {
    if (!result) return '';
    if (typeof result.getText === 'function') {
      const v = result.getText();
      return typeof v === 'string' ? v.trim() : '';
    }
    if (typeof result.text === 'string') return result.text.trim();
    return '';
  }

  private onCodeDetected(value: string): void {
    this.stopScanner();
    const numericOnly = value.replace(/\D/g, '');
    this.eanInput.set(numericOnly || value);
    this.lookupEan();
  }

  private stopScanner(): void {
    this.scannerActive.set(false);
    this.scannerLoading.set(false);

    if (this.zxingControls) {
      try {
        this.zxingControls.stop();
      } catch {
        // ignore
      }
      this.zxingControls = null;
    }

    if (this.zxingReader && typeof this.zxingReader.reset === 'function') {
      try {
        this.zxingReader.reset();
      } catch {
        // ignore
      }
    }
    this.zxingReader = null;

    const video = this.inventoryVideo?.nativeElement;
    if (video) video.srcObject = null;
  }

  private adjustStock(itemId: string, delta: number, reason: 'consume' | 'restock', updateScanItem: boolean): void {
    this.api
      .post('/api/items/stock-adjust/', this.auth.token(), {
        item_id: itemId,
        quantity_delta: delta,
        reason,
      })
      .subscribe((res: any) => {
        if (this.isApiError(res)) {
          this.snackBar.open('Bestand konnte nicht geändert werden.', 'OK', { duration: 2500 });
          return;
        }

        const updatedItem = (res?.item || null) as Item | null;
        if (updatedItem) {
          this.items.update((list) => list.map((x) => (x.id === updatedItem.id ? { ...x, ...updatedItem } : x)));
          if (updateScanItem) {
            this.scanItem.set(updatedItem);
          }
        } else {
          this.reloadItems();
        }

        const text = delta > 0 ? 'Bestand erhöht.' : 'Bestand reduziert.';
        this.snackBar.open(text, 'OK', { duration: 1800 });
      });
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
