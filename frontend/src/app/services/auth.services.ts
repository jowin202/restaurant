import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { catchError, map, of } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuthService {

  /* ------------------------------------------------------
     STATE (als Signals, wichtig für ZONELESS!)
  ------------------------------------------------------ */
  logged_in = signal(false);
  password_error = signal(false);

  token = signal<string>('');
  username = signal<string>('');
  admin_level = signal<number>(0);
  channel_id = signal<number>(-1);

  ready = signal(false);



  constructor(
    private http: HttpClient
  ) {
    this.restore_token_from_browser();
  }

  /* ------------------------------------------------------
     LOGIN
  ------------------------------------------------------ */
  do_login(username: string, password: string, remember: boolean): void {

    this.password_error.set(false);

    const headers = new HttpHeaders({
      'accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    });

    const body = new HttpParams()
      .set("username", username)
      .set("password", password);

    this.http.post("/api/login/", body, { headers }).pipe(

      map((response: any) => {
        if (!this.isJson(response)) {
          throw new Error("Response is not valid JSON.");
        }
        return response;
      }),

      catchError((error) => {
        if (error.status === 400) {
          this.password_error.set(true);
        }
        return of(null);
      })

    ).subscribe((response) => {

      if (!response) return;

      // Erfolgreich
      if ("access_token" in response && "admin" in response) {

        this.admin_level.set(response["admin"]);
        this.token.set(response["access_token"]);
        this.username.set(username);
        this.logged_in.set(true);

        // Persistent speichern
        if (remember) {
          localStorage.setItem("token", response["access_token"]);
        } else {
          localStorage.removeItem("token");
        }

        sessionStorage.setItem("token", response["access_token"]);

      }
    });
  }

  /* ------------------------------------------------------
     LOGIN FROM TOKEN (Auto-Login aus localStorage/sessionStorage)
  ------------------------------------------------------ */
  do_login_from_token(token: string): void {
    this.ready.set(false);

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    });

    this.http.get<{username: string, admin: number}>("/api/login/from_token/" + token + "/", { headers }).pipe(
      catchError((error) => {
        console.error("Token Login failed", error);
        return of(null);
      })

    ).subscribe((response) => {

      if (response && "username" in response && "admin" in response) {
        this.token.set(token);
        this.username.set(response["username"]);
        this.admin_level.set(response["admin"]);
        this.logged_in.set(true);
        sessionStorage.setItem("token", token);

      }

      // Egal ob erfolgreich oder fehlgeschlagen:
      this.ready.set(true);
    });
  }

  do_login_with_magic_token(token: string): void {
    this.password_error.set(false);
    this.ready.set(false);

    const headers = new HttpHeaders({
      'accept': 'application/json',
      'Content-Type': 'application/json'
    });

    this.http.post("/api/login/magic/", { token }, { headers }).pipe(
      map((response: any) => {
        if (!this.isJson(response)) {
          throw new Error("Response is not valid JSON.");
        }
        return response;
      }),
      catchError(() => {
        this.password_error.set(true);
        return of(null);
      })
    ).subscribe((response) => {
      if (response && "access_token" in response && "admin" in response) {
        this.admin_level.set(response["admin"]);
        this.token.set(response["access_token"]);
        this.username.set((response["username"] ?? '').toString());
        this.logged_in.set(true);
        sessionStorage.setItem("token", response["access_token"]);
      }

      this.ready.set(true);
    });
  }

  /* ------------------------------------------------------
     TOKEN RESTORE
  ------------------------------------------------------ */
  private restore_token_from_browser(): void {

    let token = sessionStorage.getItem("token");
    if (!token) {
      token = localStorage.getItem("token") ?? '';
    }

    if (token) {
      // beim Laden des Tokens NICHT sofort ready setzen
      this.do_login_from_token(token);
    } else {
      // kein Token → sofort fertig
      this.ready.set(true);
    }
  }

  /* ------------------------------------------------------
     LOGOUT
  ------------------------------------------------------ */
  do_logout(): void {

    const currentToken = this.token();

    if (currentToken) {
      const headers = new HttpHeaders({
        'Authorization': 'Bearer ' + currentToken
      });
      this.http.get("/api/login/logout/", { headers }).subscribe(() => { /* ignored */ });
    }

    sessionStorage.removeItem("token");
    localStorage.removeItem("token");

    this.username.set('');
    this.admin_level.set(0);
    this.channel_id.set(-1);
    this.token.set('');
    this.logged_in.set(false);
    this.password_error.set(false);

  }

  /* ------------------------------------------------------
     JSON CHECK
  ------------------------------------------------------ */
  private isJson(json: any) {
    try {
      JSON.parse(JSON.stringify(json));
      return true;
    } catch {
      return false;
    }
  }
}
