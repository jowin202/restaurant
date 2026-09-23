import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject, signal, ChangeDetectionStrategy } from '@angular/core';

import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';
import { prepareImageForUpload } from '../../shared/image-utils';
import { HtmlEditor } from '../html-editor/html-editor';

type ItemType = 'essen' | 'getränk';
type OrderInputType = 'string' | 'select' | 'boolean';

interface OrderAttributeRow {
  key: string;
  label: string;
  input_type: OrderInputType;
  required: boolean;
  options_text: string;
}

interface Item {
  id: string;
  name: string;
  item_type: ItemType;
  description_html?: string | null;
  price_eur?: number | null;
  order_attributes?: Array<{
    key: string;
    label: string;
    input_type: OrderInputType;
    required: boolean;
    options: string[];
  }>;
  quantity: number | null;
  unit: string | null;
  ean?: string | null;
  has_image: boolean;
  image_data_url?: string | null;
  image_data_urls?: string[];
  images?: Array<{ id: string; filename?: string; content_type?: string }>;
}

@Component({
  selector: 'app-item-edit',
  standalone: true,
  imports: [
    RouterModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    MatSnackBarModule,
    HtmlEditor
],
  templateUrl: './item-edit.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./item-edit.css'],
})
export class ItemEdit implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  @ViewChild('captureVideo') captureVideo?: ElementRef<HTMLVideoElement>;

  private photoStream: MediaStream | null = null;

  itemId = '';
  loading = signal(true);
  saving = signal(false);
  imageBusy = signal(false);
  cameraActive = signal(false);
  cameraLoading = signal(false);

  imageUrlDraft = signal('');
  currentImageDataUrls = signal<string[]>([]);
  imageMetas = signal<Array<{ id: string; filename?: string; content_type?: string }>>([]);

  orderAttributeRows = signal<OrderAttributeRow[]>([
    { key: '', label: '', input_type: 'string', required: false, options_text: '' },
  ]);

  form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    item_type: new FormControl<ItemType>('essen', { nonNullable: true }),
    description_html: new FormControl<string>(''),
    price_eur: new FormControl<number | null>(null),
    quantity: new FormControl<number | null>(null),
    unit: new FormControl<string>(''),
    ean: new FormControl<string>(''),
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.router.navigate(['/items/list']);
      return;
    }

    this.itemId = id;
    this.loadItem();
  }

  ngOnDestroy(): void {
    this.stopCamera();
  }


  addOrderAttributeRow(): void {
    this.orderAttributeRows.update((rows) => [
      ...rows,
      { key: '', label: '', input_type: 'string', required: false, options_text: '' },
    ]);
  }

  removeOrderAttributeRow(index: number): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone.splice(index, 1);
      return clone.length > 0
        ? clone
        : [{ key: '', label: '', input_type: 'string', required: false, options_text: '' }];
    });
  }

  onOrderAttributeKeyChange(index: number, value: string): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], key: value };
      return clone;
    });
  }

  onOrderAttributeLabelChange(index: number, value: string): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], label: value };
      return clone;
    });
  }

  onOrderAttributeTypeChange(index: number, value: OrderInputType): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], input_type: value, options_text: value === 'select' ? clone[index].options_text : '' };
      return clone;
    });
  }

  onOrderAttributeRequiredChange(index: number, value: boolean): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], required: value };
      return clone;
    });
  }

  onOrderAttributeOptionsChange(index: number, value: string): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], options_text: value };
      return clone;
    });
  }

  async onFileSelected(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const files = target.files ? Array.from(target.files) : [];
    target.value = '';
    if (files.length === 0) return;

    this.imageBusy.set(true);
    let failed = 0;
    for (const file of files) {
      const ok = await this.uploadSingleFile(file);
      if (!ok) failed += 1;
    }
    this.imageBusy.set(false);
    this.loadItem();

    if (failed === 0) {
      this.snackBar.open('Bilder wurden direkt hochgeladen.', 'OK', { duration: 2200 });
    } else {
      this.snackBar.open('Einige Bilder konnten nicht hochgeladen werden (z. B. zu groß/ungültig).', 'OK', { duration: 3400 });
    }
  }

  async onCameraCapture(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const files = target.files ? Array.from(target.files) : [];
    target.value = '';
    if (files.length === 0) return;

    this.imageBusy.set(true);
    let failed = 0;
    for (const file of files) {
      const ok = await this.uploadSingleFile(file);
      if (!ok) failed += 1;
    }
    this.imageBusy.set(false);
    this.loadItem();

    if (failed === 0) {
      this.snackBar.open('Foto wurde direkt hochgeladen.', 'OK', { duration: 2200 });
    } else {
      this.snackBar.open('Foto teilweise/gar nicht hochgeladen.', 'OK', { duration: 2800 });
    }
  }

  async openCameraCapture(fallbackInput: HTMLInputElement): Promise<void> {
    if (this.cameraActive()) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      fallbackInput.click();
      return;
    }

    try {
      this.cameraLoading.set(true);
      this.photoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.cameraActive.set(true);

      setTimeout(async () => {
        const video = this.captureVideo?.nativeElement;
        if (!video || !this.photoStream) return;

        video.srcObject = this.photoStream;
        try {
          await video.play();
        } catch {
          // ignore autoplay errors; user can still interact
        }
      });
    } catch {
      this.stopCamera();
      fallbackInput.click();
      this.snackBar.open('Webcam konnte nicht gestartet werden. Datei-Dialog wird verwendet.', 'OK', { duration: 2800 });
    } finally {
      this.cameraLoading.set(false);
    }
  }

  stopCamera(): void {
    this.cameraActive.set(false);
    this.cameraLoading.set(false);

    if (this.photoStream) {
      this.photoStream.getTracks().forEach((track) => track.stop());
      this.photoStream = null;
    }

    const video = this.captureVideo?.nativeElement;
    if (video) {
      video.srcObject = null;
    }
  }

  async takeCameraPhoto(): Promise<void> {
    const video = this.captureVideo?.nativeElement;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      this.snackBar.open('Kamerabild ist noch nicht bereit.', 'OK', { duration: 2000 });
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.snackBar.open('Fotoaufnahme fehlgeschlagen.', 'OK', { duration: 2200 });
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
      this.snackBar.open('Foto konnte nicht erstellt werden.', 'OK', { duration: 2200 });
      return;
    }

    const file = new File([blob], `camera-${Date.now()}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });

    this.imageBusy.set(true);
    const ok = await this.uploadSingleFile(file);
    this.imageBusy.set(false);

    this.stopCamera();
    this.loadItem();
    this.snackBar.open(ok ? 'Foto wurde direkt hochgeladen.' : 'Foto-Upload fehlgeschlagen.', 'OK', {
      duration: ok ? 2200 : 2800,
    });
  }

  setImageUrl(value: string): void {
    this.imageUrlDraft.set(value);
  }

  saveItem(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const payload = this.buildPayload();
    if (!payload) {
      return;
    }

    this.saving.set(true);
    this.api.put(`/api/items/${this.itemId}/`, this.auth.token(), payload).subscribe((res: any) => {
      this.saving.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Item konnte nicht gespeichert werden.', 'OK', { duration: 3000 });
        return;
      }

      this.snackBar.open('Änderungen gespeichert.', 'OK', { duration: 2200 });
      this.loadItem();
    });
  }

  importImageFromUrl(): void {
    const url = this.imageUrlDraft().trim();
    if (!url) {
      this.snackBar.open('Bitte eine Bild-URL eingeben.', 'OK', { duration: 2200 });
      return;
    }

    this.imageBusy.set(true);
    this.api.post(`/api/items/${this.itemId}/image/from-url/`, this.auth.token(), { url }).subscribe((res: any) => {
      this.imageBusy.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Bild konnte nicht von URL übernommen werden.', 'OK', { duration: 3000 });
        return;
      }

      this.snackBar.open('Bild von URL übernommen.', 'OK', { duration: 2200 });
      this.imageUrlDraft.set('');
      this.loadItem();
    });
  }

  removeImage(imageId?: string): void {
    this.imageBusy.set(true);
    const url = imageId
      ? `/api/items/${this.itemId}/image/?image_id=${encodeURIComponent(imageId)}`
      : `/api/items/${this.itemId}/image/`;

    this.api.delete(url, this.auth.token()).subscribe((res: any) => {
      this.imageBusy.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Bild konnte nicht entfernt werden.', 'OK', { duration: 2500 });
        return;
      }

      this.snackBar.open('Bild entfernt.', 'OK', { duration: 2200 });
      this.loadItem();
    });
  }

  private loadItem(): void {
    this.loading.set(true);
    this.api.get(`/api/items/${this.itemId}/?include_images=true`, this.auth.token()).subscribe((res: any) => {
      this.loading.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Item konnte nicht geladen werden.', 'OK', { duration: 2800 });
        return;
      }

      const item = res as Item;
      this.form.patchValue({
        name: item.name,
        item_type: item.item_type,
        description_html: item.description_html || '',
        price_eur: item.price_eur ?? null,
        quantity: item.quantity,
        unit: item.unit || '',
        ean: item.ean || '',
      });

      const orderRows = (item.order_attributes || []).map((x) => ({
        key: x.key || '',
        label: x.label || x.key || '',
        input_type: x.input_type || 'string',
        required: !!x.required,
        options_text: Array.isArray(x.options) ? x.options.join(',') : '',
      }));
      this.orderAttributeRows.set(
        orderRows.length > 0
          ? orderRows
          : [{ key: '', label: '', input_type: 'string', required: false, options_text: '' }]
      );

      this.currentImageDataUrls.set(
        Array.isArray(item.image_data_urls) && item.image_data_urls.length > 0
          ? item.image_data_urls
          : item.image_data_url
            ? [item.image_data_url]
            : []
      );
      this.imageMetas.set(Array.isArray(item.images) ? item.images : []);
      this.imageUrlDraft.set('');
    });
  }

  private async uploadSingleFile(file: File): Promise<boolean> {
    const optimizedFile = await prepareImageForUpload(file);
    const formData = new FormData();
    formData.append('file', optimizedFile, optimizedFile.name);

    const res = await firstValueFrom(this.api.upload(`/api/items/${this.itemId}/image/`, this.auth.token(), formData));
    return !this.isApiError(res);
  }

  private buildPayload(): any | null {
    const orderAttributes: Array<{
      key: string;
      label: string;
      input_type: OrderInputType;
      required: boolean;
      options: string[];
    }> = [];

    for (const row of this.orderAttributeRows()) {
      const key = row.key.trim();
      if (!key) continue;

      const label = row.label.trim() || key;
      const options =
        row.input_type === 'select'
          ? row.options_text
              .split(/[,\n;]+/)
              .map((x) => x.trim())
              .filter((x) => !!x)
          : [];

      if (row.input_type === 'select' && options.length < 2) {
        this.snackBar.open(`Bitte mindestens 2 Auswahlwerte für "${label}" angeben.`, 'OK', { duration: 3200 });
        return null;
      }

      orderAttributes.push({
        key,
        label,
        input_type: row.input_type,
        required: row.required,
        options,
      });
    }

    const ean = (this.form.controls.ean.value || '').trim();
    const priceValue = this.parsePrice(this.form.controls.price_eur.value);
    if (priceValue === undefined) {
      this.snackBar.open('Preis muss eine positive Zahl sein.', 'OK', { duration: 2600 });
      return null;
    }

    return {
      name: this.form.controls.name.value.trim(),
      item_type: this.form.controls.item_type.value,
      description_html: this.normalizeDescriptionHtml(this.form.controls.description_html.value),
      order_attributes: orderAttributes,
      price_eur: priceValue,
      quantity: this.form.controls.quantity.value,
      unit: (this.form.controls.unit.value || '').trim() || null,
      ean: ean || null,
    };
  }

  private parsePrice(value: number | null): number | null | undefined {
    if (value === null || value === undefined) {
      return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return undefined;
    }

    return Math.round(parsed * 100) / 100;
  }

  private normalizeDescriptionHtml(value: string | null | undefined): string | null {
    const html = (value || '').trim();
    if (!html) return null;

    const textOnly = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
    return textOnly ? html : null;
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
