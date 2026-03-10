
import { Component, OnInit, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

interface OrderLinePreview {
  name: string;
  ordered_quantity: number;
  unit: string | null;
  unit_price_eur?: number | null;
  line_total_eur?: number | null;
  order_answers: Record<string, any>;
}

interface OrderPaymentPreview {
  prices_enabled?: boolean;
  voucher_codes_enabled?: boolean;
  subtotal_eur?: number;
  credit_applied_eur?: number;
  total_due_eur?: number;
  remaining_credit_eur?: number;
}

interface AdminOrder {
  id: string;
  user_id?: string | null;
  user_name?: string | null;
  status: string;
  print_status?: string;
  print_error?: string;
  comment?: string | null;
  created_at: string;
  item_count: number;
  total_quantity: number;
  payment?: OrderPaymentPreview;
  items: OrderLinePreview[];
}

@Component({
  selector: 'app-orders-admin',
  standalone: true,
  imports: [MatCardModule, MatButtonModule, MatSnackBarModule],
  templateUrl: './orders-admin.html',
  styleUrl: './orders-admin.css',
})
export class OrdersAdmin implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  loading = signal(false);
  orders = signal<AdminOrder[]>([]);

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);

    this.api.get('/api/orders/?limit=80', this.auth.token()).subscribe((ordersRes: any) => {
      this.loading.set(false);

      if (this.isApiError(ordersRes)) {
        this.orders.set([]);
        this.snackBar.open('Bestellungen konnten nicht geladen werden.', 'OK', { duration: 2500 });
        return;
      }

      this.orders.set((ordersRes as AdminOrder[]) || []);
    });
  }

  manageOrder(order: AdminOrder): void {
    this.api.post(`/api/orders/${order.id}/manage/`, this.auth.token(), {}).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Verwaltung konnte nicht gestartet werden.', 'OK', { duration: 2500 });
        return;
      }
      this.snackBar.open('Verwaltungsfunktion ist vorbereitet.', 'OK', { duration: 2200 });
    });
  }

  preparePrint(order: AdminOrder): void {
    this.api.post(`/api/orders/${order.id}/prepare-print/`, this.auth.token(), {}).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Druck fehlgeschlagen.', 'OK', { duration: 2500 });
        return;
      }
      const message = String(res?.message || 'Druckauftrag verarbeitet.');
      this.snackBar.open(message, 'OK', { duration: 2600 });
      this.reload();
    });
  }

  formatOrderDate(value: string): string {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString('de-DE');
  }

  statusLabel(status: string): string {
    const normalized = String(status || '').trim().toLowerCase();

    if (normalized === 'pending_integration') return 'Neu';
    if (normalized === 'processing') return 'In Bearbeitung';
    if (normalized === 'completed') return 'Abgeschlossen';
    if (normalized === 'cancelled') return 'Storniert';
    if (normalized === 'printed') return 'Gedruckt';

    return 'Offen';
  }

  lineAnswerEntries(line: OrderLinePreview): Array<{ label: string; value: string }> {
    const answers = line.order_answers;
    if (!answers || typeof answers !== 'object') return [];

    const entries: Array<{ label: string; value: string }> = [];
    for (const key of Object.keys(answers).sort()) {
      const rawValue = answers[key];

      if (typeof rawValue === 'string' && rawValue.trim().length === 0) {
        continue;
      }

      const label = String(key || '').trim();
      if (!label) {
        continue;
      }

      const renderedValue = this.stringifyAnswer(rawValue).trim();
      if (!renderedValue) {
        continue;
      }

      entries.push({
        label,
        value: renderedValue,
      });
    }

    return entries;
  }

  showPrices(order: AdminOrder): boolean {
    return Boolean(order.payment?.prices_enabled);
  }

  formatPrice(value: number | null | undefined): string {
    const numeric = Number(value ?? 0);
    const rounded = Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
    return `${rounded.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }

  private stringifyAnswer(value: any): string {
    if (typeof value === 'boolean') {
      return value ? 'Ja' : 'Nein';
    }

    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    return String(value).trim();
  }
}
