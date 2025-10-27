# Keep Socket.IO callbacks and Firebase models
-keepclassmembers class * {
    @com.google.firebase.firestore.PropertyName <fields>;
}
