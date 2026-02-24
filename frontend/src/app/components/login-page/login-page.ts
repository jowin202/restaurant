import { Component, effect, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { AuthService } from '../../services/auth.services';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';

@Component({
  selector: 'app-login-page',
  imports: [
    RouterModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    MatButtonModule],
  templateUrl: './login-page.html',
  styleUrl: './login-page.css',
})
export class LoginPage {

  
  loading = signal(false);
  linkLoginTried = signal(false);

  passwordErrorText = signal('');

  form = new FormGroup({
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    stayLoggedIn: new FormControl(false, { nonNullable: true })
  });

  constructor(private auth: AuthService, private router: Router, private route: ActivatedRoute) {

    // Fehler automatisch anzeigen, wenn Backend 400 liefert
    effect(() => {
      if (this.auth.password_error()) {
        this.loading.set(false);
        this.passwordErrorText.set('Benutzername oder Passwort ist falsch.');
      } else {
        this.passwordErrorText.set('');
      }
    });

    
    // 🔥 Navigation wenn Login erfolgreich wird
    effect(() => {
      if (this.auth.logged_in()) {

        // Spinner beenden
        this.loading.set(false);

        // 🔥 Weiterleitung zur Hauptseite
        this.router.navigate(['/']);
      }
    });

    const magicTokenFromLink = this.route.snapshot.queryParamMap.get('magic');
    if (magicTokenFromLink && magicTokenFromLink.trim().length > 0) {
      this.linkLoginTried.set(true);
      this.loading.set(true);
      this.auth.do_login_with_magic_token(magicTokenFromLink.trim());
    }

    effect(() => {
      if (!this.linkLoginTried()) return;
      if (this.auth.logged_in()) return;
      if (!this.auth.ready()) return;

      this.loading.set(false);
      this.passwordErrorText.set('Login-Link ist ungültig.');
    });

  }

  onLogin() {
    this.passwordErrorText.set('');
    this.auth.password_error.set(false);
    this.loading.set(true);

    const { username, password, stayLoggedIn } = this.form.value;

    this.auth.do_login(
      username ?? '',
      password ?? '',
      stayLoggedIn ?? false
    );
  }
  
}
