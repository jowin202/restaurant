import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

interface VoucherCodeItem {
  id: string;
  code: string;
  amount_eur: number;
  expires_at: string | null;
  created_at: string | null;
  created_by_name?: string | null;
  redeemed_at?: string | null;
  redeemed_by_name?: string | null;
  status: 'active' | 'expired' | 'redeemed' | string;
}

interface VoucherListResponse {
  vouchers_enabled?: boolean;
  items?: VoucherCodeItem[];
}

@Component({
  selector: 'app-voucher-codes',
  standalone: true,
  imports: [
    RouterModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSnackBarModule,
  ],
  templateUrl: './voucher-codes.html',
  styleUrl: './voucher-codes.css',
})
export class VoucherCodes implements OnInit {
  private api = inject(ApiService);
  auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  loading = signal(false);
  generating = signal(false);
  vouchersEnabled = signal(false);
  items = signal<VoucherCodeItem[]>([]);

  amountEur = signal('10');
  expiresAt = signal(this.defaultExpiryDateTime());
  codeCount = signal('1');

  ngOnInit(): void {
    this.reload();
  }

  setAmountEur(value: string): void {
    this.amountEur.set(value);
  }

  setExpiresAt(value: string): void {
    this.expiresAt.set(value);
  }

  setCodeCount(value: string): void {
    this.codeCount.set(value);
  }

  reload(): void {
    this.loading.set(true);
    this.api.get('/api/voucher-codes/?limit=220', this.auth.token()).subscribe((res: any) => {
      this.loading.set(false);

      if (this.isApiError(res)) {
        this.items.set([]);
        this.vouchersEnabled.set(false);
        this.snackBar.open('Gutschein-Codes konnten nicht geladen werden.', 'OK', { duration: 2600 });
        return;
      }

      const response = (res || {}) as VoucherListResponse;
      this.vouchersEnabled.set(Boolean(response.vouchers_enabled));
      this.items.set(Array.isArray(response.items) ? response.items : []);
    });
  }

  generate(): void {
    const amount = Number(this.amountEur().replace(',', '.'));
    const count = Number(this.codeCount());
    const expiresAtInput = this.expiresAt().trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      this.snackBar.open('Bitte einen gültigen Betrag eingeben.', 'OK', { duration: 2300 });
      return;
    }

    if (!Number.isInteger(count) || count <= 0 || count > 100) {
      this.snackBar.open('Anzahl muss zwischen 1 und 100 liegen.', 'OK', { duration: 2400 });
      return;
    }

    const parsedExpiry = new Date(expiresAtInput);
    if (Number.isNaN(parsedExpiry.getTime())) {
      this.snackBar.open('Bitte ein gültiges Ablaufdatum eingeben.', 'OK', { duration: 2400 });
      return;
    }

    this.generating.set(true);
    this.api.post('/api/voucher-codes/generate/', this.auth.token(), {
      amount_eur: amount,
      expires_at: parsedExpiry.toISOString(),
      count,
    }).subscribe((res: any) => {
      this.generating.set(false);

      if (this.isApiError(res) || res?.detail) {
        const detail = String(res?.detail || 'Codes konnten nicht erstellt werden.');
        this.snackBar.open(detail, 'OK', { duration: 3000 });
        return;
      }

      this.snackBar.open('Gutschein-Codes wurden erstellt.', 'OK', { duration: 2400 });
      this.reload();
    });
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString('de-DE');
  }

  formatPrice(value: number): string {
    const rounded = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
    return `${rounded.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
  }

  statusLabel(value: string): string {
    const status = String(value || '').toLowerCase();
    if (status === 'active') return 'Aktiv';
    if (status === 'redeemed') return 'Eingelöst';
    if (status === 'expired') return 'Abgelaufen';
    return 'Unbekannt';
  }

  private defaultExpiryDateTime(): string {
    const now = new Date();
    now.setDate(now.getDate() + 30);
    now.setHours(23, 59, 0, 0);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
