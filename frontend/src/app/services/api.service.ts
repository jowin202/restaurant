import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, map, Observable, of } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  constructor(private http: HttpClient) { }
  public_infos: any = [];



  upload(url: string, auth_token: string, object: any): Observable<any> {
    var headers = new HttpHeaders({
    });
    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }

    return this.http.post(url,
      object, // data from parameter
      { headers: headers }).pipe(

        map((response: any) => {
          if (this.isJson(response)) {
            return response;
          } else {
            return [{ "error_code": -1, "error_string": "no valid json" }]
          }
        }),
        catchError((error: any) => {
          //if (error.status === 401) {
          //  return []
          //}
          return of([{ "error_code": error.status, "error_string": "Exception" }])
        })
      );
  }


  pic_dict: { [key: string]: any } = {};
  download_pic(url: string, auth_token: string, forceDownload: boolean = false) {
    var headers = new HttpHeaders({
    });
    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }

    if (forceDownload || !this.pic_dict.hasOwnProperty(url))
      this.http.get(url, { headers: headers, responseType: 'blob' }).subscribe((result) => {
        this.pic_dict[url] = URL.createObjectURL(result);
      });
  }






  post(url: string, auth_token: string, object: any): Observable<any> {
    var headers = new HttpHeaders({
      'Content-Type': "application/json",
    });
    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }

    return this.http.post(url,
      object, // data from parameter
      { headers: headers }).pipe(

        map((response: any) => {
          if (this.isJson(response)) {
            return response;
          } else {
            return [{ "error_code": -1, "error_string": "no valid json" }]
          }
        }),
        catchError((error: any) => {
          //if (error.status === 401) {
          //  return []
          //}
          return of([{ "error_code": error.status, "error_string": "Exception" }])
        })
      );
  }

  get(url: string, auth_token: string): Observable<any> {
    var headers = new HttpHeaders({
      'Content-Type': 'application/json',
    });
    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }

    return this.http.get(url,
      { headers: headers }).pipe(

        map((response: any) => {
          if (this.isJson(response)) {
            return response;
          } else {
            return [{ "error_code": -1, "error_string": "no valid json" }]
          }
        }),
        catchError((error: any) => {
          //if (error.status === 401) {
          //  return []
          //}
          return of([{ "error_code": error.status, "error_string": "Exception" }])
        })
      );
  }


  //for backup
  getFileStream(url: string, auth_token: string): Observable<any> {
    let headers = new HttpHeaders();

    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }

    // WICHTIG: Kein 'Content-Type': 'application/json' im Header bei Downloads,
    // da wir nichts senden und einen Stream (Blob) empfangen wollen.
    return this.http.get(url, {
      headers: headers,
      responseType: 'blob', // Sagt Angular, dass es kein JSON parsen soll
      observe: 'response'    // Erlaubt Zugriff auf Header (z.B. Dateiname)
    }).pipe(
      map((res: any) => {
        // Da wir 'blob' erwarten, gibt es hier keine isJson-Prüfung.
        // Wir geben das gesamte Response-Objekt zurück.
        return res;
      }),
      catchError((error: any) => {
        return of([{ "error_code": error.status, "error_string": "Download Exception" }]);
      })
    );
  }

  uploadBackup(url: string, auth_token: string, formData: FormData): Observable<any> {
    let headers = new HttpHeaders();
    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }
    // WICHTIG: Kein 'Content-Type' setzen!

    return this.http.post(url, formData, { headers: headers });
  }




  put(url: string, auth_token: string, object: any): Observable<any> {
    var headers = new HttpHeaders({
      'Content-Type': 'application/json',
    });
    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }

    return this.http.put(url,
      object, // data from parameter
      { headers: headers }).pipe(

        map((response: any) => {
          if (this.isJson(response)) {
            return response;
          } else {
            return [{ "error_code": -1, "error_string": "no valid json" }]
          }
        }),
        catchError((error: any) => {
          //if (error.status === 401) {
          //  return []
          //}
          return of([{ "error_code": error.status, "error_string": "Exception" }])
        })
      );
  }


  delete(url: string, auth_token: string): Observable<any> {
    var headers = new HttpHeaders({
      'Content-Type': 'application/json',
    });
    if (auth_token) {
      headers = headers.set('Authorization', 'Bearer ' + auth_token);
    }

    return this.http.delete(url,
      { headers: headers }).pipe(

        map((response: any) => {
          if (this.isJson(response)) {
            return response;
          } else {
            return [{ "error_code": -1, "error_string": "no valid json" }]
          }
        }),
        catchError((error: any) => {
          //if (error.status === 401) {
          //  return []
          //}
          return of([{ "error_code": error.status, "error_string": "Exception" }])
        })
      );
  }




  private isJson(json: any) {
    try {
      JSON.parse(JSON.stringify(json));
      return true;
    } catch (e) {
      return false;
    }
  }


}
