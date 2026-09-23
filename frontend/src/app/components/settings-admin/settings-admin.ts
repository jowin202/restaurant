
import { Component, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

const SETTINGS_KEYS = [
  'receipt_printer_ip',
  'label_printer_ip',
  'label_printer_width_mm',
  'label_printer_height_mm',
  'label_printer_dpi',
  'label_printer_zpl_template',
  'guest_qr_invite_text',
  'display_timezone',
  'prices_enabled',
  'voucher_codes_enabled',
] as const;

const DEFAULT_INVITE_TEXT = 'Lieber [Name], Bitte scanne den QR Code ab um zu unserem Restaurant zu gelangen.';

@Component({
  selector: 'app-settings-admin',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatButtonModule,
    MatSnackBarModule
],
  templateUrl: './settings-admin.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './settings-admin.css',
})
export class SettingsAdmin implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  loading = signal(false);
  saving = signal(false);

  form = new FormGroup({
    receipt_printer_ip: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(120)],
    }),
    label_printer_ip: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(120)],
    }),
    label_printer_width_mm: new FormControl('', {
      nonNullable: true,
      validators: [Validators.pattern(/^\d*$/), Validators.maxLength(4)],
    }),
    label_printer_height_mm: new FormControl('', {
      nonNullable: true,
      validators: [Validators.pattern(/^\d*$/), Validators.maxLength(4)],
    }),
    label_printer_dpi: new FormControl('203', {
      nonNullable: true,
      validators: [Validators.pattern(/^(203|300)$/)],
    }),
    label_printer_zpl_template: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(4000)],
    }),
    guest_qr_invite_text: new FormControl(DEFAULT_INVITE_TEXT, {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(500)],
    }),
    display_timezone: new FormControl('Europe/Vienna', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    prices_enabled: new FormControl(false, { nonNullable: true }),
    voucher_codes_enabled: new FormControl(false, { nonNullable: true }),
  });

  previewText = computed(() => {
    const template = this.form.controls.guest_qr_invite_text.value || DEFAULT_INVITE_TEXT;
    return template.replace(/\[name\]/gi, 'Max');
  });

  ngOnInit(): void {
    this.loadSettings();
  }

  loadSettings(): void {
    this.loading.set(true);

    this.api.post('/api/settings/get_settings/', this.auth.token(), [...SETTINGS_KEYS]).subscribe((res: any) => {
      this.loading.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Einstellungen konnten nicht geladen werden.', 'OK', { duration: 2500 });
        return;
      }

      const values = (res || {}) as Record<string, any>;
      const labelPrinterDpi = String(values['label_printer_dpi'] ?? '203');

      this.form.patchValue({
        receipt_printer_ip: String(values['receipt_printer_ip'] || ''),
        label_printer_ip: String(values['label_printer_ip'] || ''),
        label_printer_width_mm: String(values['label_printer_width_mm'] || ''),
        label_printer_height_mm: String(values['label_printer_height_mm'] || ''),
        label_printer_dpi: labelPrinterDpi === '300' ? '300' : '203',
        label_printer_zpl_template: String(values['label_printer_zpl_template'] || ''),
        guest_qr_invite_text: String(values['guest_qr_invite_text'] || DEFAULT_INVITE_TEXT),
        display_timezone: String(values['display_timezone'] || 'Europe/Vienna'),
        prices_enabled: this.toBool(values['prices_enabled']),
        voucher_codes_enabled: this.toBool(values['voucher_codes_enabled']),
      });
    });
  }

  saveSettings(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.snackBar.open('Bitte Eingaben prüfen.', 'OK', { duration: 2200 });
      return;
    }

    const payload = {
      receipt_printer_ip: this.form.controls.receipt_printer_ip.value.trim(),
      label_printer_ip: this.form.controls.label_printer_ip.value.trim(),
      label_printer_width_mm: String(this.form.controls.label_printer_width_mm.value ?? '').trim(),
      label_printer_height_mm: String(this.form.controls.label_printer_height_mm.value ?? '').trim(),
      label_printer_dpi: Number(this.form.controls.label_printer_dpi.value),
      label_printer_zpl_template: this.form.controls.label_printer_zpl_template.value.trim(),
      guest_qr_invite_text: this.form.controls.guest_qr_invite_text.value.trim(),
      display_timezone: this.form.controls.display_timezone.value.trim() || 'Europe/Vienna',
      prices_enabled: this.form.controls.prices_enabled.value,
      voucher_codes_enabled: this.form.controls.voucher_codes_enabled.value,
    };

    this.saving.set(true);
    this.api.post('/api/settings/set_settings/', this.auth.token(), payload).subscribe((res: any) => {
      this.saving.set(false);

      if (this.isApiError(res) || res?.error) {
        this.snackBar.open('Einstellungen konnten nicht gespeichert werden.', 'OK', { duration: 2500 });
        return;
      }

      this.snackBar.open('Einstellungen gespeichert.', 'OK', { duration: 2200 });
    });
  }

  resetInviteText(): void {
    this.form.controls.guest_qr_invite_text.setValue(DEFAULT_INVITE_TEXT);
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }

  private toBool(value: any): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      return lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on' || lowered === 'ja';
    }
    return false;
  }
}
