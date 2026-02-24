import { Component, OnDestroy, OnInit, ViewChild, ElementRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

type ItemType = 'essen' | 'getränk';

interface Item {
  id: string;
  name: string;
  item_type: ItemType;
  attributes: Record<string, any>;
  in_stock: boolean;
  quantity: number | null;
  unit: string | null;
  ean?: string | null;
  created_at: string;
  updated_at: string;
  has_image: boolean;
  image_data_url?: string | null;
}

interface DashboardData {
  summary: {
    total_items: number;
    total_food: number;
    total_drinks: number;
    total_with_images: number;
  };
  alerts: {
    low_stock: Array<{ id: string; name: string; quantity: number | null; unit: string | null }>;
  };
}

interface AttributeRow {
  key: string;
  value: string;
}

interface EanMetadata {
  source?: string;
  name?: string;
  brand?: string;
  item_type?: ItemType;
  quantity?: string | null;
  category?: string;
  attributes?: Record<string, any>;
}

interface EanLookupResult {
  ean: string;
  known: boolean;
  action: 'increase_stock' | 'create_item';
  item: Item | null;
  metadata_found: boolean;
  metadata: EanMetadata | null;
  providers_queried: string[];
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    MatSnackBarModule,
  ],
  templateUrl: './dashboard.html',
  styleUrls: ['./dashboard.css'],
})
export class Dashboard implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  @ViewChild('eanVideo') eanVideo?: ElementRef<HTMLVideoElement>;

  private barcodeDetector: any = null;
  private scannerStream: MediaStream | null = null;
  private scannerTimer: ReturnType<typeof setTimeout> | null = null;

  loading = signal(true);
  saving = signal(false);
  searchText = signal('');
  selectedFile = signal<File | null>(null);
  editingId = signal<string | null>(null);

  scannerSupported = signal<boolean>(
    typeof window !== 'undefined' &&
      !!(window as any).BarcodeDetector &&
      !!navigator.mediaDevices &&
      !!navigator.mediaDevices.getUserMedia
  );
  scannerActive = signal(false);
  eanLookupLoading = signal(false);
  eanLookupResult = signal<EanLookupResult | null>(null);
  eanInput = signal('');
  stockIncrease = signal(1);
  metadataSource = signal<string | null>(null);

  dashboardData = signal<DashboardData | null>(null);
  items = signal<Item[]>([]);
  attributeRows = signal<AttributeRow[]>([{ key: '', value: '' }]);

  form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    item_type: new FormControl<ItemType>('essen', { nonNullable: true }),
    in_stock: new FormControl(true, { nonNullable: true }),
    quantity: new FormControl<number | null>(null),
    unit: new FormControl<string>(''),
    ean: new FormControl<string>(''),
  });

  visibleItems = computed(() => {
    const search = this.searchText().trim().toLowerCase();
    if (!search) return this.items();

    return this.items().filter((item) => {
      const inName = item.name.toLowerCase().includes(search);
      const inType = item.item_type.toLowerCase().includes(search);
      const inEan = (item.ean || '').toLowerCase().includes(search);
      const inAttrs = Object.entries(item.attributes || {}).some(
        ([k, v]) => `${k} ${JSON.stringify(v)}`.toLowerCase().includes(search)
      );
      return inName || inType || inEan || inAttrs;
    });
  });

  ngOnInit(): void {
    this.reload();
  }

  ngOnDestroy(): void {
    this.stopScanner();
  }

  reload(): void {
    this.loading.set(true);

    this.api.get('/api/dashboard/', this.auth.token()).subscribe((dashboardRes: any) => {
      if (!this.isApiError(dashboardRes)) {
        this.dashboardData.set(dashboardRes);
      }
    });

    this.api.get('/api/items/?include_images=true', this.auth.token()).subscribe((itemsRes: any) => {
      if (this.isApiError(itemsRes)) {
        this.items.set([]);
        this.loading.set(false);
        this.snackBar.open('Items konnten nicht geladen werden.', 'OK', { duration: 2500 });
        return;
      }

      this.items.set(itemsRes as Item[]);
      this.loading.set(false);
    });
  }

  onSearchChange(value: string): void {
    this.searchText.set(value);
  }

  addAttributeRow(): void {
    this.attributeRows.update((rows) => [...rows, { key: '', value: '' }]);
  }

  removeAttributeRow(index: number): void {
    this.attributeRows.update((rows) => {
      const clone = [...rows];
      clone.splice(index, 1);
      return clone.length > 0 ? clone : [{ key: '', value: '' }];
    });
  }

  onAttributeKeyChange(index: number, value: string): void {
    this.attributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], key: value };
      return clone;
    });
  }

  onAttributeValueChange(index: number, value: string): void {
    this.attributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], value };
      return clone;
    });
  }

  onFileSelected(event: Event): void {
    const target = event.target as HTMLInputElement;
    const file = target.files && target.files.length > 0 ? target.files[0] : null;
    this.selectedFile.set(file);
  }

  clearFileSelection(input: HTMLInputElement): void {
    this.selectedFile.set(null);
    input.value = '';
  }

  setEanInput(value: string): void {
    this.eanInput.set(value);
    this.form.controls.ean.setValue(value);
  }

  setStockIncrease(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.stockIncrease.set(1);
      return;
    }
    this.stockIncrease.set(parsed);
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
      this.snackBar.open('Barcode-Scanner wird im aktuellen Browser nicht unterstützt.', 'OK', { duration: 3000 });
      return;
    }

    try {
      this.barcodeDetector = new (window as any).BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'],
      });

      this.scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });

      this.scannerActive.set(true);

      setTimeout(async () => {
        const video = this.eanVideo?.nativeElement;
        if (!video) return;
        video.srcObject = this.scannerStream;
        await video.play();
        this.scanLoop();
      });
    } catch {
      this.stopScanner();
      this.snackBar.open('Kamera konnte nicht gestartet werden.', 'OK', { duration: 3000 });
    }
  }

  private stopScanner(): void {
    this.scannerActive.set(false);

    if (this.scannerTimer) {
      clearTimeout(this.scannerTimer);
      this.scannerTimer = null;
    }

    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach((track) => track.stop());
      this.scannerStream = null;
    }

    const video = this.eanVideo?.nativeElement;
    if (video) {
      video.srcObject = null;
    }
  }

  private async scanLoop(): Promise<void> {
    if (!this.scannerActive()) return;

    const video = this.eanVideo?.nativeElement;
    if (!video || !this.barcodeDetector) {
      this.scannerTimer = setTimeout(() => void this.scanLoop(), 300);
      return;
    }

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      try {
        const barcodes = await this.barcodeDetector.detect(video);
        if (Array.isArray(barcodes) && barcodes.length > 0) {
          const rawValue = (barcodes[0].rawValue || '').trim();
          if (rawValue) {
            this.onEanDetected(rawValue);
            return;
          }
        }
      } catch {
        // Detector wirft gelegentlich während Kamera-Initialisierung
      }
    }

    this.scannerTimer = setTimeout(() => void this.scanLoop(), 300);
  }

  private onEanDetected(ean: string): void {
    this.stopScanner();
    this.setEanInput(ean);
    this.lookupEan();
  }

  lookupEan(): void {
    const ean = this.eanInput().trim();
    if (!ean) {
      this.snackBar.open('Bitte EAN eingeben oder scannen.', 'OK', { duration: 2200 });
      return;
    }

    this.eanLookupLoading.set(true);
    this.eanLookupResult.set(null);

    this.api.get(`/api/items/ean/${encodeURIComponent(ean)}/lookup/`, this.auth.token()).subscribe((res: any) => {
      this.eanLookupLoading.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('EAN-Suche fehlgeschlagen.', 'OK', { duration: 2500 });
        return;
      }

      const result = res as EanLookupResult;
      this.eanLookupResult.set(result);
      this.form.controls.ean.setValue(result.ean);

      if (result.known) {
        this.metadataSource.set('local_db');
        this.stockIncrease.set(1);
        this.snackBar.open('EAN bekannt. Bestand kann direkt erhöht werden.', 'OK', { duration: 2500 });
        return;
      }

      if (result.metadata_found && result.metadata) {
        this.prefillFromMetadata(result.ean, result.metadata);
        this.snackBar.open('Metadaten gefunden. Formular wurde vorausgefüllt.', 'OK', { duration: 3000 });
        return;
      }

      this.metadataSource.set(null);
      this.snackBar.open('Keine Metadaten gefunden. Bitte Produkt manuell anlegen.', 'OK', { duration: 3000 });
    });
  }

  private prefillFromMetadata(ean: string, metadata: EanMetadata): void {
    const mergedAttrs: Record<string, any> = { ...(metadata.attributes || {}) };

    if (metadata.brand && !mergedAttrs['marke']) {
      mergedAttrs['marke'] = metadata.brand;
    }

    if (metadata.category && !mergedAttrs['kategorie']) {
      mergedAttrs['kategorie'] = metadata.category;
    }

    if (metadata.quantity && !mergedAttrs['verpackung']) {
      mergedAttrs['verpackung'] = metadata.quantity;
    }

    this.form.patchValue({
      name: metadata.name || this.form.controls.name.value,
      item_type: metadata.item_type || 'essen',
      ean,
    });

    this.metadataSource.set(metadata.source || null);

    const rows = Object.entries(mergedAttrs).map(([key, value]) => ({
      key,
      value: this.stringifyValue(value),
    }));

    if (rows.length > 0) {
      this.attributeRows.set(rows);
    }
  }

  increaseStockForKnownEan(): void {
    const lookup = this.eanLookupResult();
    if (!lookup || !lookup.known) return;

    this.api.post('/api/items/ean/stock-increase/', this.auth.token(), {
      ean: lookup.ean,
      quantity_delta: this.stockIncrease(),
    }).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Bestand konnte nicht erhöht werden.', 'OK', { duration: 2500 });
        return;
      }

      this.snackBar.open('Lagerbestand wurde erhöht.', 'OK', { duration: 2200 });
      this.reload();

      if (res?.item) {
        const updatedLookup: EanLookupResult = {
          ...lookup,
          item: res.item as Item,
          metadata_found: true,
          metadata: {
            source: 'local_db',
            name: res.item.name,
            item_type: res.item.item_type,
            attributes: res.item.attributes || {},
          },
        };
        this.eanLookupResult.set(updatedLookup);
      }
    });
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const payload = this.buildPayload();
    this.saving.set(true);

    const currentId = this.editingId();
    if (currentId) {
      this.api.put(`/api/items/${currentId}/`, this.auth.token(), payload).subscribe((res: any) => {
        if (this.isApiError(res)) {
          this.finishSave(false, 'Item konnte nicht gespeichert werden.');
          return;
        }
        this.afterSave(res.id);
      });
      return;
    }

    this.api.post('/api/items/', this.auth.token(), payload).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.finishSave(false, 'Item konnte nicht erstellt werden (evtl. EAN doppelt).');
        return;
      }
      this.afterSave(res.id);
    });
  }

  edit(item: Item): void {
    this.editingId.set(item.id);
    this.form.patchValue({
      name: item.name,
      item_type: item.item_type,
      in_stock: item.in_stock,
      quantity: item.quantity,
      unit: item.unit ?? '',
      ean: item.ean ?? '',
    });

    const rows = Object.entries(item.attributes || {}).map(([key, value]) => ({
      key,
      value: this.stringifyValue(value),
    }));
    this.attributeRows.set(rows.length > 0 ? rows : [{ key: '', value: '' }]);
    this.selectedFile.set(null);

    this.eanInput.set(item.ean || '');
    this.eanLookupResult.set(null);
    this.metadataSource.set(null);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.form.reset({
      name: '',
      item_type: 'essen',
      in_stock: true,
      quantity: null,
      unit: '',
      ean: '',
    });
    this.attributeRows.set([{ key: '', value: '' }]);
    this.selectedFile.set(null);
    this.eanInput.set('');
    this.eanLookupResult.set(null);
    this.metadataSource.set(null);
  }

  remove(item: Item): void {
    if (!confirm(`Soll "${item.name}" wirklich gelöscht werden?`)) {
      return;
    }

    this.api.delete(`/api/items/${item.id}/`, this.auth.token()).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Löschen fehlgeschlagen.', 'OK', { duration: 2500 });
        return;
      }
      this.snackBar.open('Item gelöscht.', 'OK', { duration: 2000 });
      this.reload();
    });
  }

  removeImage(item: Item): void {
    this.api.delete(`/api/items/${item.id}/image/`, this.auth.token()).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Bild konnte nicht gelöscht werden.', 'OK', { duration: 2500 });
        return;
      }
      this.snackBar.open('Bild entfernt.', 'OK', { duration: 2000 });
      this.reload();
    });
  }

  private afterSave(itemId: string): void {
    const file = this.selectedFile();
    if (!file) {
      this.finishSave(true, this.editingId() ? 'Item aktualisiert.' : 'Item erstellt.');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    this.api.upload(`/api/items/${itemId}/image/`, this.auth.token(), formData).subscribe((imgRes: any) => {
      if (this.isApiError(imgRes)) {
        this.finishSave(false, 'Item gespeichert, aber Bild-Upload fehlgeschlagen.');
        return;
      }
      this.finishSave(true, 'Item inklusive Bild gespeichert.');
    });
  }

  private finishSave(success: boolean, message: string): void {
    this.saving.set(false);
    this.snackBar.open(message, 'OK', { duration: 2500 });

    if (success) {
      this.cancelEdit();
      this.reload();
    }
  }

  private buildPayload(): any {
    const attrs: Record<string, any> = {};

    for (const row of this.attributeRows()) {
      const key = row.key.trim();
      if (!key) continue;
      attrs[key] = this.parseValue(row.value);
    }

    const ean = (this.form.controls.ean.value || '').trim();

    return {
      name: this.form.controls.name.value.trim(),
      item_type: this.form.controls.item_type.value,
      attributes: attrs,
      in_stock: this.form.controls.in_stock.value,
      quantity: this.form.controls.quantity.value,
      unit: (this.form.controls.unit.value || '').trim() || null,
      ean: ean || null,
      metadata_source: this.metadataSource() || null,
    };
  }

  private parseValue(raw: string): any {
    const value = (raw ?? '').trim();

    if (!value.length) return '';
    if (value === 'true') return true;
    if (value === 'false') return false;

    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return Number(value);
    }

    if (value.startsWith('{') || value.startsWith('[') || value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    return value;
  }

  private stringifyValue(value: any): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
