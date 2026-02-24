import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import jsQR from 'jsqr';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

@Component({
  selector: 'app-qr-scanner',
  standalone: true,
  imports: [
    CommonModule, MatButtonModule, MatCardModule, MatIconModule,
    MatSnackBarModule, MatProgressSpinnerModule
  ],
  templateUrl: './qr-scanner.html',
  styleUrls: ['./qr-scanner.css', '../hund-steckbrief/hund-steckbrief.css']
})
export class QrScanner implements AfterViewInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  @ViewChild('video') video!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas') canvas!: ElementRef<HTMLCanvasElement>;

  scanning = signal<boolean>(true);
  loading = signal<boolean>(false);
  verified = signal<boolean>(false);
  error = signal<boolean>(false);
  lastResult = signal<any>(null);

  private stream: MediaStream | null = null;
  private animationId: number | null = null;

  async ngAfterViewInit() {
    await this.startCamera();
  }

  ngOnDestroy() {
    this.stopCamera();
  }

  async startCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      this.video.nativeElement.srcObject = this.stream;
      this.video.nativeElement.play();
      this.scanning.set(true);
      this.verified.set(false);
      this.error.set(false);
      this.animationId = requestAnimationFrame(() => this.tick());
    } catch (err) {
      this.snackBar.open('Kamerazugriff verweigert.', 'OK', { duration: 3000 });
    }
  }

  stopCamera() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    this.scanning.set(false);
  }

  tick() {
    const video = this.video.nativeElement;
    if (video.readyState === video.HAVE_ENOUGH_DATA && this.scanning()) {
      const canvas = this.canvas.nativeElement;
      canvas.height = video.videoHeight;
      canvas.width = video.videoWidth;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);

        if (code && code.data) {
          this.verifyQrCode(code.data);
          return;
        }
      }
    }
    if (this.scanning()) {
      this.animationId = requestAnimationFrame(() => this.tick());
    }
  }

  verifyQrCode(hmacKey: string) {
    this.stopCamera();

    this.loading.set(true);
    this.verified.set(false);
    this.error.set(false);
    this.lastResult.set(null);

    this.api.get(`/api/verify/qr/${hmacKey}`, this.auth.token()).subscribe({
      next: (res: any) => {
        this.loading.set(false);

        console.log(res);

        if (res.status == "ok") {
          if (res.check_update && res.check_update.is_latest === false) {
            this.verified.set(true);
            this.lastResult.set(res);
            this.snackBar.open('Warnung: Veraltete Version!', 'OK', { duration: 5000 });
            return;
          }

          // Alles OK
          this.verified.set(true);
          this.lastResult.set(res);
          this.snackBar.open('Code erfolgreich verifiziert!', 'OK', { duration: 3000 });
        }
        else {
          this.loading.set(false);

          // --- SCHRITT 2: STATUS BEI FEHLER ---
          this.verified.set(false); // Sicherstellen, dass Grün weg ist
          this.error.set(true);      // UI auf Rot schalten

          const msg =  'Ungültiger Code';
          this.snackBar.open(msg, 'OK', { duration: 5000 });
        }

      },
      error: (err) => {

      }
    });
  }


  resetScanner() {
    this.startCamera();
  }
}