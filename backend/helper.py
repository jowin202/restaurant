
import string
import random
import os

import smtplib
from email.message import EmailMessage

from typing import Union

from datetime import datetime

import hmac
import hashlib
import base64



def token_generate():
    password = []
    characterList = ""
    characterList += string.ascii_letters
    characterList += string.digits
    for i in range(32):
        randomchar = random.choice(characterList)
        password.append(randomchar)
    return str("".join(password))


def send_mail(receiver_email, subject, body):
    smtp_server = os.getenv('SMTP_HOST')
    smtp_port = os.getenv('SMTP_PORT') 
    sender_email = os.getenv('MAIL_ADDRESS') 
    sender_password = os.getenv('MAIL_PASSWORD') 

    # Create the email
    msg = EmailMessage()
    msg["From"] = sender_email
    msg["To"] = receiver_email
    msg["Subject"] = subject
    msg.set_content(body)

    # Send the email via SMTP over SSL
    try:
        with smtplib.SMTP_SSL(smtp_server, smtp_port) as server:
            server.login(sender_email, sender_password)
            server.send_message(msg)
        print("Email sent successfully!")
    except Exception as e:
        print(f"Failed to send email: {e}")


def calc_hmac(message: Union[str, bytes]) -> str:
    key_bytes = bytes.fromhex(os.getenv("HMAC_KEY"))

    if isinstance(message, str):
        message_bytes = message.encode("utf-8")
    elif isinstance(message, bytes):
        message_bytes = message
    else:
        raise TypeError("message must be str or bytes")

    hmac_result = hmac.new(
        key_bytes,
        message_bytes,
        hashlib.sha256
    ).digest()

    return base64.b64encode(hmac_result).decode("utf-8")