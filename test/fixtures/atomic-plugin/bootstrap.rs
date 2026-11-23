//! Disposable bootstrap through the real pinned Atomic Rust API.
//! The ontology shape follows atomic-server/server/src/plugins/test_fixture.rs.
//! No authorization, consent, route, or storage implementation is replaced.
use atomic_lib::{urls, Db, Resource, Storelike, Value};
use std::{error::Error, path::Path};

async fn genesis(db: &Db, values: Vec<(&str, Value)>) -> Result<String, Box<dyn Error + Send + Sync>> {
    let mut resource = Resource::new("did:ad:placeholder".into());
    for (key, value) in values { resource.set_unsafe(key.into(), value)?; }
    resource.save_as_genesis(db).await?;
    Ok(resource.get_subject().to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 { return Err("usage: bootstrap STORE UPLOADS PLUGIN_JS OUTPUT_JSON".into()); }
    let db = Db::init_redb_file(Path::new(&args[1]), Some("http://localhost:9887".into()), Path::new(&args[2])).await?;
    let (agent, drive) = db.setup("Native backend acceptance").await?;
    let ontology = genesis(&db, vec![
        (urls::IS_A, Value::ResourceArray(vec![urls::ONTOLOGY.into()])),
        (urls::PARENT, Value::AtomicUrl(drive.as_str().into())),
        (urls::SHORTNAME, Value::Slug("plugins".into())),
        (urls::NAME, Value::String("Plugin vocabulary".into())),
        (urls::DESCRIPTION, Value::Markdown("Disposable native acceptance ontology".into())),
    ]).await?;
    let mut properties = Vec::new();
    let mut source_property = String::new();
    for (name, datatype) in [
        ("plugin-source", urls::MARKDOWN), ("plugin-schemas", urls::JSON),
        ("plugin-connection", urls::JSON), ("automation-integrations", urls::RESOURCE_ARRAY),
        ("trigger", urls::STRING), ("started-at", urls::TIMESTAMP),
        ("run-status", urls::STRING), ("run-problems", urls::JSON),
        ("run-outcomes", urls::JSON), ("run-cursor", urls::STRING),
        ("app-identities", urls::ATOMIC_URL), ("row-extras", urls::RESOURCE_ARRAY),
    ] {
        let subject = genesis(&db, vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::PROPERTY.into()])),
            (urls::PARENT, Value::AtomicUrl(ontology.as_str().into())),
            (urls::SHORTNAME, Value::Slug(name.into())),
            (urls::NAME, Value::String(name.into())),
            (urls::DESCRIPTION, Value::Markdown(name.into())),
            (urls::DATATYPE_PROP, Value::AtomicUrl(datatype.into())),
        ]).await?;
        if name == "plugin-source" { source_property = subject.clone(); }
        properties.push(subject.into());
    }
    let mut classes = Vec::new();
    let mut plugin_class = String::new();
    for (name, title) in [("plugin-script", "Plugin"), ("plugin-run", "Plugin run"), ("app", "App")] {
        let subject = genesis(&db, vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::CLASS.into()])),
            (urls::PARENT, Value::AtomicUrl(ontology.as_str().into())),
            (urls::SHORTNAME, Value::Slug(name.into())),
            (urls::NAME, Value::String(title.into())),
            (urls::DESCRIPTION, Value::Markdown(title.into())),
        ]).await?;
        if name == "plugin-script" { plugin_class = subject.clone(); }
        classes.push(subject.into());
    }
    let mut resource = db.get_resource(&ontology.as_str().into()).await?;
    resource.set_unsafe(urls::PROPERTIES.into(), Value::ResourceArray(properties))?;
    resource.set_unsafe(urls::CLASSES.into(), Value::ResourceArray(classes))?;
    resource.save(&db).await?;
    let mut resource = db.get_resource(&drive.as_str().into()).await?;
    resource.set_unsafe(urls::DEFAULT_ONTOLOGY.into(), Value::AtomicUrl(ontology.as_str().into()))?;
    resource.save(&db).await?;
    let folder = genesis(&db, vec![
        (urls::IS_A, Value::ResourceArray(vec![urls::FOLDER.into()])),
        (urls::PARENT, Value::AtomicUrl(drive.as_str().into())),
        (urls::NAME, Value::String("Native remoteStorage documents".into())),
    ]).await?;
    let plugin = genesis(&db, vec![
        (urls::IS_A, Value::ResourceArray(vec![plugin_class.as_str().into()])),
        (urls::PARENT, Value::AtomicUrl(drive.as_str().into())),
        (urls::NAME, Value::String("remoteStorage".into())),
        (source_property.as_str(), Value::Markdown(std::fs::read_to_string(&args[3])?)),
    ]).await?;
    db.flush()?;
    let output = serde_json::json!({ "secret": agent.build_secret()?, "drive": drive, "folder": folder, "plugin": plugin });
    std::fs::write(&args[4], serde_json::to_vec(&output)?)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&args[4], std::fs::Permissions::from_mode(0o600))?;
    }
    println!("Created signed native agent, drive, ontology, folder and plugin; private bootstrap JSON written.");
    Ok(())
}
